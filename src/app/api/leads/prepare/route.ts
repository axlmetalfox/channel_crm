import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { ManualLeadError, prepareManualLead } from '@/lib/leads/manual'

/**
 * POST /api/leads/prepare  { conversation_id }
 *
 * An agent asks to send a stalled conversation to the CRM by hand. The
 * app reads the chat and proposes the lead as a draft for the agent to
 * review; nothing is sent yet (see /api/leads/submit).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`manual-lead:${userId}`, RATE_LIMITS.manualLead)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as { conversation_id?: unknown }
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    }

    // The agent must be able to see the conversation (row-level security).
    const { data: visible } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!visible) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const db = supabaseAdmin()
    const config = await loadAiConfig(db, accountId, { requireActive: false })
    if (!config) {
      return NextResponse.json(
        { error: 'The AI assistant is not configured for this account', code: 'ai_unavailable' },
        { status: 400 },
      )
    }

    const draft = await prepareManualLead(db, config, { accountId, conversationId, userId })
    return NextResponse.json({
      intake_id: draft.intakeId,
      lead: draft.lead,
      consent_given: draft.consentGiven,
      already_delivered_at: draft.alreadyDeliveredAt,
      known_in_crm: draft.knownInCrm,
    })
  } catch (err) {
    if (err instanceof ManualLeadError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
