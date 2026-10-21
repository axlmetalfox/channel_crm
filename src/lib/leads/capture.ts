import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError, type AiConfig, type ChatMessage } from '@/lib/ai/types'
import { deliverWebhookEvent } from '@/lib/webhooks/deliver'
import { extractLead } from './extract'
import { judgeLead, type Lead } from './schema'
import {
  fillLeadFromRecord,
  fillLeadFromRemembered,
  previousLeadDetails,
  type CrmMatch,
} from './lookup'
import { consentFromNotice } from './consent'
import { reconcileWhatsApp } from './phone'
import { zohoLeadIdFrom } from './zoho-id'
import { reportLeadConversion } from './conversion'

// ============================================================
// Lead capture: turn a finished AI interview into a `lead.captured`
// webhook event, durably.
//
//   captureLead      runs right after the closing message is sent. It
//                    writes a `lead_intakes` row first (the idempotency
//                    key and retry queue), then extracts and delivers.
//   retryLeadIntakes re-runs whatever did not complete, from the cron.
//
// Every step records its outcome on the intake row, so a lead is never
// silently lost: it is delivered, or its row says why it was not.
// ============================================================

/** Give up after this many delivery / extraction attempts. */
export const MAX_INTAKE_ATTEMPTS = 6
/** Stop retrying intakes older than this. */
const MAX_INTAKE_AGE_MS = 3 * 24 * 60 * 60 * 1000
/** Cap on interview messages fed to the extraction call. */
const TRANSCRIPT_MESSAGE_LIMIT = 120
/** Cap on transcript characters shipped to the CRM in the payload. */
const PAYLOAD_TRANSCRIPT_CHARS = 8000

const RETRYABLE_STATUSES = ['pending', 'failed', 'no_endpoint']

/** Click-to-WhatsApp source saved on the conversation (see migration 048). */
export interface Attribution {
  source_type: string | null
  source_id: string | null
  source_url: string | null
  headline: string | null
  body: string | null
  media_type: string | null
  ctwa_clid: string | null
  captured_at: string
}

export interface IntakeRow {
  id: string
  account_id: string
  conversation_id: string | null
  contact_id: string | null
  status: string
  payload: LeadPayload | null
  attempts: number
  created_at: string
  last_attempt_at: string | null
}

/** The neutral event body; CRM-specific mapping happens in the receiver. */
export interface LeadPayload {
  intake_id: string
  conversation_id: string | null
  contact_id: string | null
  /** The number the conversation runs on, as WhatsApp reports it. */
  channel_phone: string | null
  lead: Omit<Lead, 'consent_given'>
  consent: {
    given: true
    captured_at: string
    /** 'advisor': nothing in the chat shows it; the advisor who sent the lead
     *  confirmed that the customer was informed and authorized (`confirmed_by`). */
    method: 'notice' | 'chat' | 'advisor'
    confirmed_by?: { user_id: string; name: string | null }
  }
  /** Set when the customer was already registered in the CRM. */
  existing_record: { module: string; id: string } | null
  /** The ad or post the customer's chat started from, when it did. */
  attribution: Attribution | null
  /** Set when a person sent the lead from the inbox instead of the AI. */
  registered_by: { user_id: string; name: string | null } | null
  /** What the customer typed as their WhatsApp when it differed from the number
   *  they wrote from (the chat's number is the one sent). */
  whatsapp_reported?: string | null
  /** Free notes the agent added (manual leads only). */
  notes?: string | null
  transcript: { role: 'customer' | 'assistant'; text: string }[]
}

interface CaptureArgs {
  db: SupabaseClient
  config: AiConfig
  accountId: string
  conversationId: string
  contactId: string
  /** Provider id of the closing message; makes the capture idempotent. */
  triggerMessageId: string
}

/**
 * Start (and run) the capture for one finished interview. Never throws.
 * A second call for the same closing message is a no-op.
 */
export async function captureLead(args: CaptureArgs): Promise<void> {
  const { db, config, accountId, conversationId, contactId } = args
  try {
    const { data: intake, error } = await db
      .from('lead_intakes')
      .insert({
        account_id: accountId,
        conversation_id: conversationId,
        contact_id: contactId,
        trigger_message_id: args.triggerMessageId,
      })
      .select(
        'id, account_id, conversation_id, contact_id, status, payload, attempts, created_at, last_attempt_at',
      )
      .single()
    if (error) {
      // 23505: this closing message was already captured.
      if (error.code !== '23505') {
        console.error('[lead capture] intake insert failed:', error)
      }
      return
    }

    // The interview is over: give the conversation a fresh reply budget so
    // the same person can open a second request later (a quote today,
    // service next month are two leads).
    await db
      .from('conversations')
      .update({ ai_reply_count: 0 })
      .eq('id', conversationId)

    await processIntake(db, config, intake as IntakeRow)
  } catch (err) {
    console.error('[lead capture] capture failed:', err)
  }
}

/**
 * Re-run intakes that did not complete (extraction failed, the CRM
 * endpoint was down or not yet configured). Backs off per attempt.
 * Called by the cron route; never throws.
 */
export async function retryLeadIntakes(
  db: SupabaseClient,
  opts: { limit?: number; now?: Date } = {},
): Promise<{ checked: number; delivered: number }> {
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - MAX_INTAKE_AGE_MS).toISOString()
  let delivered = 0
  let checked = 0
  try {
    const { data, error } = await db
      .from('lead_intakes')
      .select(
        'id, account_id, conversation_id, contact_id, status, payload, attempts, created_at, last_attempt_at',
      )
      .in('status', RETRYABLE_STATUSES)
      .lt('attempts', MAX_INTAKE_ATTEMPTS)
      .gt('created_at', since)
      .order('created_at', { ascending: true })
      .limit(50)
    if (error) throw error

    const due = ((data ?? []) as IntakeRow[])
      .filter((r) => isDue(r, now))
      .slice(0, opts.limit ?? 20)

    const configs = new Map<string, AiConfig | null>()
    for (const row of due) {
      checked += 1
      let config: AiConfig | null = null
      if (!row.payload) {
        // Extraction still has to run, so the account's model is needed.
        if (!configs.has(row.account_id)) {
          configs.set(
            row.account_id,
            await loadAiConfig(db, row.account_id, { requireActive: false }).catch(
              () => null,
            ),
          )
        }
        config = configs.get(row.account_id) ?? null
      }
      const status = await processIntake(db, config, row)
      if (status === 'delivered') delivered += 1
    }
  } catch (err) {
    console.error('[lead capture] retry sweep failed:', err)
  }
  return { checked, delivered }
}

/** Exponential backoff: 2, 4, 8 ... minutes (capped at an hour). */
function isDue(row: IntakeRow, now: Date): boolean {
  if (!row.last_attempt_at) return true
  const waitMs = Math.min(60, 2 ** row.attempts) * 60_000
  return now.getTime() - new Date(row.last_attempt_at).getTime() >= waitMs
}

/**
 * Take one attempt at an intake: extract if needed, then deliver.
 * Returns the resulting status, or null when another worker had it.
 */
export async function processIntake(
  db: SupabaseClient,
  config: AiConfig | null,
  row: IntakeRow,
): Promise<string | null> {
  // Optimistic claim: bump `attempts` only if nobody else did first, so
  // the original run and a retry sweep can't both work the same intake.
  const { data: claimed } = await db
    .from('lead_intakes')
    .update({
      attempts: row.attempts + 1,
      last_attempt_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('attempts', row.attempts)
    .in('status', RETRYABLE_STATUSES)
    .select('id')
  if (!Array.isArray(claimed) || claimed.length === 0) return null

  const finish = async (
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    await db.from('lead_intakes').update({ status, ...extra }).eq('id', row.id)
    return status
  }

  let payload = row.payload
  if (!payload) {
    if (!config) return finish('pending', { error: 'AI config unavailable' })
    const built = await buildPayload(db, config, row)
    if ('status' in built) return finish(built.status, built.extra)
    payload = built.payload
    await db.from('lead_intakes').update({ payload }).eq('id', row.id)
  }

  const result = await deliverWebhookEvent(
    db,
    row.account_id,
    'lead.captured',
    payload,
    { eventId: row.id },
  )
  if (result.endpoints === 0) {
    return finish('no_endpoint', { error: 'No endpoint subscribed to lead.captured' })
  }
  if (result.delivered < result.endpoints) {
    return finish('failed', {
      error: `${result.delivered}/${result.endpoints} endpoints accepted the lead`,
    })
  }
  // The lead now exists in the CRM: let the next message look the customer
  // up afresh (a first-time customer becomes a registered one).
  // The request is in the CRM, so the conversation is done: close it. A
  // new message from the customer re-opens it.
  if (row.conversation_id) {
    // Remember the CRM's id for this customer's lead: it is how the CRM
    // later tells us about the lead (e.g. its sales rep) even when the
    // customer has no visible phone number.
    const zohoLeadId = zohoLeadIdFrom(result.responses)
    await db
      .from('conversations')
      .update({
        crm_match: null,
        status: 'closed',
        updated_at: new Date().toISOString(),
        ...(zohoLeadId ? { zoho_lead_id: zohoLeadId } : {}),
      })
      .eq('id', row.conversation_id)
  }
  const status = await finish('delivered', { error: null, delivered_at: new Date().toISOString() })

  // A lead that came from a Meta ad is reported back to Meta, so the ad
  // learns which clicks become real leads. Recorded on the intake; it can
  // never undo the delivery above.
  const conversion = await reportLeadConversion(
    db,
    row,
    { email: payload.lead.email },
    payload.attribution ?? null,
  )
  await db.from('lead_intakes').update({ conversion }).eq('id', row.id)
  return status
}

type Built =
  | { payload: LeadPayload }
  | { status: string; extra: Record<string, unknown> }

/** Extract + judge the lead, then assemble the event body. */
async function buildPayload(
  db: SupabaseClient,
  config: AiConfig,
  row: IntakeRow,
): Promise<Built> {
  if (!row.conversation_id) {
    return { status: 'incomplete', extra: { error: 'Conversation was deleted' } }
  }
  const transcript = await loadInterviewMessages(
    db,
    row.conversation_id,
    row.created_at,
  )
  if (transcript.length === 0) {
    return { status: 'incomplete', extra: { error: 'No interview messages found' } }
  }

  let lead: Lead
  try {
    const extracted = await extractLead(config, transcript)
    lead = extracted.lead
    void logAiUsage(db, {
      accountId: row.account_id,
      conversationId: row.conversation_id,
      mode: 'lead_extract',
      provider: config.provider,
      model: config.model,
      usage: extracted.usage,
    })
  } catch (err) {
    const message = err instanceof AiError ? err.message : 'Extraction failed'
    console.error('[lead capture] extraction failed:', err)
    // Stays retryable: the model may simply have been unreachable.
    return { status: 'pending', extra: { error: message } }
  }

  // A customer the CRM already knows is not asked for their details again:
  // complete the lead from the CRM record.
  const { data: convRow } = await db
    .from('conversations')
    .select('crm_match, attribution')
    .eq('id', row.conversation_id)
    .maybeSingle()
  const crm = (convRow?.crm_match as CrmMatch | null | undefined) ?? null
  const attribution = (convRow?.attribution as Attribution | null | undefined) ?? null

  const { data: contact } = row.contact_id
    ? await db.from('contacts').select('phone').eq('id', row.contact_id).maybeSingle()
    : { data: null }
  const channelPhone = (contact?.phone as string | null | undefined) ?? null

  if (crm?.status === 'found' && crm.record) {
    lead = fillLeadFromRecord(lead, crm.record, channelPhone)
  }

  // Details the customer gave for an earlier request in this same chat.
  const previous = await previousLeadDetails(db, row.conversation_id)
  if (previous) lead = fillLeadFromRemembered(lead, previous)

  // The WhatsApp number is the one the customer wrote from, not the one they
  // typed (which they sometimes get wrong).
  const reconciled = reconcileWhatsApp(lead, channelPhone)
  lead = reconciled.lead

  // The account's data notice was sent first and the customer carried on:
  // that is the authorization, whatever the model read in the chat.
  const noticeConsent = await consentFromNotice(db, row.conversation_id, config.consentNotice)
  if (noticeConsent.given) lead = { ...lead, consent_given: true }

  const verdict = judgeLead(lead)
  if (verdict === 'no_consent') {
    return {
      status: 'no_consent',
      extra: { error: 'The customer did not give data-processing consent' },
    }
  }
  if (verdict === 'incomplete') {
    return {
      status: 'incomplete',
      extra: {
        error: 'Missing the first name or any way to reach the customer',
        payload: { lead },
      },
    }
  }

  const payload: LeadPayload = {
    intake_id: row.id,
    conversation_id: row.conversation_id,
    contact_id: row.contact_id,
    channel_phone: channelPhone,
    lead: {
      first_name: lead.first_name,
      last_name: lead.last_name,
      email: lead.email,
      company: lead.company,
      document_id: lead.document_id,
      whatsapp_number: lead.whatsapp_number,
      // No separate contact phone means the WhatsApp number is it.
      contact_phone: lead.contact_phone ?? lead.whatsapp_number,
      country: lead.country,
      city: lead.city,
      department: lead.department,
      request_summary: lead.request_summary,
      request_type: lead.request_type,
    },
    consent: {
      given: true,
      captured_at: noticeConsent.at ?? row.created_at,
      method: noticeConsent.given ? 'notice' : 'chat',
    },
    existing_record:
      crm?.status === 'found' && crm.id ? { module: crm.module ?? 'Leads', id: crm.id } : null,
    attribution,
    registered_by: null,
    whatsapp_reported: reconciled.reported,
    transcript: trimTranscript(transcript),
  }
  return { payload }
}

/**
 * Recent text messages of the conversation up to this intake's creation
 * (the closing message is sent before the intake is made, so it is in).
 *
 * Deliberately not cut at the previous intake: a customer who comes
 * back for a second request does not repeat their name and contact
 * data, so the extraction needs the earlier part of the chat. The
 * extraction prompt tells the model to describe only the latest request.
 */
export async function loadInterviewMessages(
  db: SupabaseClient,
  conversationId: string,
  intakeCreatedAt: string,
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio'])
    .lte('created_at', intakeCreatedAt)
    .order('created_at', { ascending: false })
    .limit(TRANSCRIPT_MESSAGE_LIMIT)
  if (error) throw error

  return ((data ?? []) as { sender_type: string; content_type: string; content_text: string | null }[])
    .reverse()
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: (m.content_type === 'audio' ? '[Audio transcrito] ' : '') + m.content_text!.trim(),
    }))
}

/** Keep the most recent part of the transcript within the size budget. */
export function trimTranscript(messages: ChatMessage[]): LeadPayload['transcript'] {
  const out: LeadPayload['transcript'] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    used += messages[i].content.length
    if (used > PAYLOAD_TRANSCRIPT_CHARS && out.length > 0) break
    out.unshift({
      role: messages[i].role === 'user' ? 'customer' : 'assistant',
      text: messages[i].content,
    })
  }
  return out
}
