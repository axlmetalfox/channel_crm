import type { SupabaseClient } from '@supabase/supabase-js'
import { loadZernioConfig } from '@/lib/zernio/config'
import {
  getWhatsAppDataset,
  provisionWhatsAppDataset,
  sendWhatsAppConversion,
  ZernioError,
} from '@/lib/zernio/client'

// ============================================================
// Tell Meta that a click-to-WhatsApp ad produced a lead.
//
// When a captured lead reached the CRM and its chat started from a Meta
// ad (we hold the click id, `ctwa_clid`), Zernio can send Meta a
// `LeadSubmitted` event for it through the Conversions API. Meta then
// learns which clicks turn into real leads and steers the ad toward
// them, instead of toward people who only say hello.
//
// Best-effort and idempotent: the intake id is the event id, a failure
// is recorded on the intake (never retried into the lead pipeline), and
// nothing here can stop a lead from being delivered.
// ============================================================

export interface ConversionOutcome {
  status: 'sent' | 'failed' | 'skipped'
  at: string
  /** Why it was skipped or failed. */
  reason?: string
  /** Meta's trace id, for support tickets. */
  trace_id?: string
}

interface IntakeForConversion {
  id: string
  account_id: string
  conversation_id: string | null
}

/**
 * Report one delivered lead to Meta. Returns what happened; the caller
 * stores it on the intake. Never throws.
 */
export async function reportLeadConversion(
  db: SupabaseClient,
  intake: IntakeForConversion,
  lead: { email: string | null },
  attribution: { ctwa_clid: string | null } | null,
): Promise<ConversionOutcome> {
  const at = new Date().toISOString()
  const skipped = (reason: string): ConversionOutcome => ({ status: 'skipped', at, reason })

  try {
    if (!attribution?.ctwa_clid) return skipped('The chat did not start from a Meta ad')
    if (!intake.conversation_id) return skipped('No conversation')

    const config = await loadZernioConfig(db, intake.account_id)
    if (!config) return skipped('The account does not use Zernio')

    const { data: conv } = await db
      .from('conversations')
      .select('zernio_conversation_id')
      .eq('id', intake.conversation_id)
      .maybeSingle()
    const zernioConversationId = conv?.zernio_conversation_id as string | null | undefined
    if (!zernioConversationId) return skipped('The conversation has no Zernio thread')

    // The WABA needs a conversions dataset once; provisioning is idempotent.
    const existing = await getWhatsAppDataset({ apiKey: config.apiKey, accountId: config.zernioAccountId })
    if (!existing.datasetId) {
      await provisionWhatsAppDataset({ apiKey: config.apiKey, accountId: config.zernioAccountId })
    }

    const testCode = process.env.META_CONVERSION_TEST_CODE?.trim() || undefined
    const result = await sendWhatsAppConversion({
      apiKey: config.apiKey,
      accountId: config.zernioAccountId,
      conversationId: zernioConversationId,
      eventName: 'LeadSubmitted',
      eventId: intake.id,
      eventTime: Math.floor(Date.now() / 1000),
      email: lead.email,
      testCode,
    })

    if (result.eventsFailed > 0 || result.eventsReceived === 0) {
      return {
        status: 'failed',
        at,
        reason: result.failures[0]?.message ?? 'Meta did not accept the event',
        trace_id: result.traceId ?? undefined,
      }
    }
    return { status: 'sent', at, trace_id: result.traceId ?? undefined }
  } catch (err) {
    const reason =
      err instanceof ZernioError ? `${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}` : 'Unexpected error'
    console.error('[lead conversion] failed:', err)
    return { status: 'failed', at, reason: reason.slice(0, 300) }
  }
}
