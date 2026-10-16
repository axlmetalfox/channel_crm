import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError, type AiConfig } from '@/lib/ai/types'
import { extractLead } from './extract'
import { fillLeadFromRecord, type CrmMatch } from './lookup'
import { judgeLead, LEAD_REQUEST_TYPES, parseLead, type Lead } from './schema'
import {
  loadInterviewMessages,
  processIntake,
  trimTranscript,
  type Attribution,
  type IntakeRow,
  type LeadPayload,
} from './capture'

// ============================================================
// Leads an agent sends by hand.
//
// A chat that stalled before the AI closed the interview can be finished
// by a person:
//
//   prepareManualLead  reads the chat, proposes the lead (same extraction
//                      the AI flow uses) and stores it as a DRAFT intake.
//                      Nothing leaves the app.
//   submitManualLead   takes the agent's edits, re-checks them on the
//                      server, and delivers the lead like an AI-captured
//                      one, marked "registered from TUYO CRM by <agent>".
//
// The data-processing consent flag comes from the stored draft, never
// from the browser: a lead whose chat shows no authorization cannot be
// sent by editing a form.
// ============================================================

export type ManualLeadErrorCode =
  | 'not_found'
  | 'no_messages'
  | 'ai_unavailable'
  | 'extraction_failed'
  | 'already_submitted'
  | 'invalid_lead'
  | 'consent_required'
  | 'incomplete'

export class ManualLeadError extends Error {
  constructor(
    readonly code: ManualLeadErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ManualLeadError'
  }
}

/** What the form shows and edits. */
export type EditableLead = Omit<Lead, 'consent_given'>

export interface ManualLeadDraft {
  intakeId: string
  lead: EditableLead
  /** Whether the chat shows the customer authorizing data processing. */
  consentGiven: boolean
  /** When a lead for this chat was already delivered, else null. */
  alreadyDeliveredAt: string | null
  /** Whether the CRM already knew this customer (their data filled gaps). */
  knownInCrm: boolean
}

interface ConversationRow {
  id: string
  contact_id: string | null
  crm_match: CrmMatch | null
  attribution: Attribution | null
}

async function loadConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<ConversationRow> {
  const { data } = await db
    .from('conversations')
    .select('id, contact_id, crm_match, attribution')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data) throw new ManualLeadError('not_found', 'Conversation not found', 404)
  return data as ConversationRow
}

async function channelPhone(db: SupabaseClient, contactId: string | null): Promise<string | null> {
  if (!contactId) return null
  const { data } = await db.from('contacts').select('phone').eq('id', contactId).maybeSingle()
  const phone = ((data?.phone as string | null | undefined) ?? '').trim()
  return phone || null
}

/** The fields the form edits: everything but the consent flag. */
function editableFields(lead: Lead): EditableLead {
  return {
    first_name: lead.first_name,
    last_name: lead.last_name,
    email: lead.email,
    company: lead.company,
    whatsapp_number: lead.whatsapp_number,
    contact_phone: lead.contact_phone,
    country: lead.country,
    city: lead.city,
    request_summary: lead.request_summary,
    request_type: lead.request_type,
  }
}

/**
 * Read the chat and propose a lead. Stores a draft intake (not sent,
 * never retried) and returns what the agent should review.
 */
export async function prepareManualLead(
  db: SupabaseClient,
  config: AiConfig,
  args: { accountId: string; conversationId: string; userId: string },
): Promise<ManualLeadDraft> {
  const { accountId, conversationId, userId } = args
  const conv = await loadConversation(db, accountId, conversationId)

  const transcript = await loadInterviewMessages(db, conversationId, new Date().toISOString())
  if (transcript.length === 0) {
    throw new ManualLeadError('no_messages', 'There are no text messages to read in this conversation', 400)
  }

  let lead: Lead
  try {
    const extracted = await extractLead(config, transcript)
    lead = extracted.lead
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'lead_extract',
      provider: config.provider,
      model: config.model,
      usage: extracted.usage,
    })
  } catch (err) {
    if (err instanceof AiError && err.code === 'unsupported_provider') {
      throw new ManualLeadError('ai_unavailable', err.message, 400)
    }
    console.error('[manual lead] extraction failed:', err)
    throw new ManualLeadError('extraction_failed', 'Could not read the conversation. Try again.', 502)
  }

  // Same completion the AI flow applies: what the CRM already holds fills
  // the gaps, and the chat's own number is the WhatsApp number.
  const phone = await channelPhone(db, conv.contact_id)
  const crm = conv.crm_match
  const knownInCrm = crm?.status === 'found' && !!crm.record
  if (knownInCrm && crm?.record) lead = fillLeadFromRecord(lead, crm.record, phone)
  else if (!lead.whatsapp_number && phone) lead = { ...lead, whatsapp_number: `+${phone.replace(/\D/g, '')}` }

  const { data: delivered } = await db
    .from('lead_intakes')
    .select('delivered_at')
    .eq('conversation_id', conversationId)
    .eq('status', 'delivered')
    .order('delivered_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: intake, error } = await db
    .from('lead_intakes')
    .insert({
      account_id: accountId,
      conversation_id: conversationId,
      contact_id: conv.contact_id,
      trigger_message_id: `manual:${randomUUID()}`,
      status: 'draft',
      source: 'manual',
      created_by_user_id: userId,
      draft: { lead },
    })
    .select('id')
    .single()
  if (error || !intake) {
    console.error('[manual lead] draft insert failed:', error)
    throw new ManualLeadError('extraction_failed', 'Could not prepare the lead', 500)
  }

  return {
    intakeId: (intake as { id: string }).id,
    lead: editableFields(lead),
    consentGiven: lead.consent_given,
    alreadyDeliveredAt: (delivered?.delivered_at as string | null | undefined) ?? null,
    knownInCrm,
  }
}

interface DraftRow {
  id: string
  account_id: string
  conversation_id: string | null
  contact_id: string | null
  status: string
  created_by_user_id: string | null
  draft: { lead?: Lead } | null
  created_at: string
}

/**
 * Deliver a reviewed lead. `edits` is what the agent typed in the form;
 * it is validated here and merged over the stored draft's consent flag.
 */
export async function submitManualLead(
  db: SupabaseClient,
  args: {
    accountId: string
    intakeId: string
    userId: string
    userName: string | null
    edits: unknown
  },
): Promise<{ status: string; error: string | null }> {
  const { accountId, intakeId, userId, userName } = args

  const { data } = await db
    .from('lead_intakes')
    .select('id, account_id, conversation_id, contact_id, status, created_by_user_id, draft, created_at')
    .eq('id', intakeId)
    .eq('account_id', accountId)
    .eq('source', 'manual')
    .maybeSingle()
  const row = data as DraftRow | null
  if (!row || row.created_by_user_id !== userId) {
    throw new ManualLeadError('not_found', 'Draft not found', 404)
  }
  if (row.status !== 'draft') {
    throw new ManualLeadError('already_submitted', 'This lead was already sent', 409)
  }

  const consent = row.draft?.lead?.consent_given === true
  const e = (args.edits && typeof args.edits === 'object' ? args.edits : {}) as Record<string, unknown>
  const lead = parseLead({
    first_name: e.first_name,
    last_name: e.last_name,
    email: e.email,
    company: e.company,
    whatsapp_number: e.whatsapp_number,
    contact_phone: e.contact_phone,
    country: e.country,
    city: e.city,
    request_summary: e.request_summary,
    request_type: LEAD_REQUEST_TYPES.find((t) => t === e.request_type),
    consent_given: consent,
  })
  if (!lead) {
    throw new ManualLeadError('invalid_lead', 'Describe the request and choose its type', 400)
  }
  const verdict = judgeLead(lead)
  if (verdict === 'no_consent') {
    throw new ManualLeadError(
      'consent_required',
      'The customer has not authorized the processing of their data in this chat',
      400,
    )
  }
  if (verdict === 'incomplete') {
    throw new ManualLeadError('incomplete', 'A first name and a way to reach the customer are required', 400)
  }

  const conv = row.conversation_id
    ? await loadConversation(db, accountId, row.conversation_id)
    : null
  const transcript = row.conversation_id
    ? await loadInterviewMessages(db, row.conversation_id, new Date().toISOString())
    : []
  const crm = conv?.crm_match ?? null
  const leadFields = editableFields(lead)

  const payload: LeadPayload = {
    intake_id: row.id,
    conversation_id: row.conversation_id,
    contact_id: row.contact_id,
    channel_phone: await channelPhone(db, row.contact_id),
    lead: {
      ...leadFields,
      // No separate contact phone means the WhatsApp number is it.
      contact_phone: lead.contact_phone ?? lead.whatsapp_number,
    },
    consent: { given: true, captured_at: row.created_at },
    existing_record:
      crm?.status === 'found' && crm.id ? { module: crm.module ?? 'Leads', id: crm.id } : null,
    attribution: conv?.attribution ?? null,
    registered_by: { user_id: userId, name: userName },
    transcript: trimTranscript(transcript),
  }

  const { error } = await db
    .from('lead_intakes')
    .update({ payload, status: 'pending', attempts: 0, error: null, last_attempt_at: null })
    .eq('id', row.id)
    .eq('status', 'draft')
  if (error) {
    console.error('[manual lead] could not queue the lead:', error)
    throw new ManualLeadError('incomplete', 'Could not send the lead', 500)
  }

  const queued: IntakeRow = {
    id: row.id,
    account_id: accountId,
    conversation_id: row.conversation_id,
    contact_id: row.contact_id,
    status: 'pending',
    payload,
    attempts: 0,
    created_at: row.created_at,
    last_attempt_at: null,
  }
  const status = await processIntake(db, null, queued)
  // `null` means another worker already had it; it is queued either way and
  // the retry sweep delivers it.
  return { status: status ?? 'pending', error: null }
}
