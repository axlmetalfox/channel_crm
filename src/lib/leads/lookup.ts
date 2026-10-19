import type { SupabaseClient } from '@supabase/supabase-js'
import { cleanText, normalizeEmail } from './normalize'
import type { Lead } from './schema'

// ============================================================
// "Is this person already in the CRM?"
//
// A returning customer should not be interviewed again. The CRM is
// asked through an operator-run endpoint (an n8n workflow in the pilot)
// configured by CUSTOMER_LOOKUP_URL / CUSTOMER_LOOKUP_SECRET:
//
//   POST { phone?, email? }  ->  { found: false }
//                              | { found: true, module, id, record }
//
// What comes back is kept server-side. The model is only told whether
// the person is registered (plus their first name when the match was
// made on the WhatsApp number itself, which the customer cannot spoof);
// it is told never to read stored data back, so asking about someone
// else's email reveals nothing but "registered / not registered".
// ============================================================

const LOOKUP_TIMEOUT_MS = 6000
/** A "not found" on the WhatsApp number is re-checked after this long
 *  (the person may have been registered in the meantime). */
const NOT_FOUND_RECHECK_MS = 6 * 60 * 60 * 1000

/** Most email checks one conversation may run: enough for a typo or two,
 *  too few to probe a list of emails to see which exist. */
export const MAX_VERIFICATIONS_PER_CONVERSATION = 3

/** The bot's question that starts a verification; matched in its last
 *  message to know the customer's next message is the answer. */
export const VERIFICATION_PHRASE = /encuentras en nuestro sistema/i

export interface CrmRecord {
  first_name: string | null
  last_name: string | null
  email: string | null
  company: string | null
  /** Cédula or NIT. */
  document_id: string | null
  mobile: string | null
  phone: string | null
  country: string | null
  city: string | null
}

export interface CrmMatch {
  status: 'found' | 'not_found'
  /** How it was matched: the WhatsApp number, or a value the customer typed. */
  source: 'whatsapp' | 'claimed'
  checked_at: string
  module?: string
  id?: string
  record?: CrmRecord
}

export type LookupOutcome =
  | { status: 'found'; module: string; id: string; record: CrmRecord }
  | { status: 'not_found' }
  | { status: 'error' }

/**
 * Whether the customer is looked up in the CRM on their own (by the
 * WhatsApp number on the first message, or by offering the email check
 * when the number is hidden). Off by default: the lookup then only runs
 * when the customer says the business already has their details.
 * Switch on with CUSTOMER_LOOKUP_AUTO=true.
 */
export function lookupAutoEnabled(): boolean {
  return process.env.CUSTOMER_LOOKUP_AUTO?.trim().toLowerCase() === 'true'
}

export function lookupConfigured(): boolean {
  return !!(process.env.CUSTOMER_LOOKUP_URL?.trim() && process.env.CUSTOMER_LOOKUP_SECRET?.trim())
}

/** Ask the CRM whether a phone / email belongs to a known person. Never throws. */
export async function lookupCustomer(clue: {
  phone?: string | null
  email?: string | null
}): Promise<LookupOutcome> {
  const url = process.env.CUSTOMER_LOOKUP_URL?.trim()
  const secret = process.env.CUSTOMER_LOOKUP_SECRET?.trim()
  if (!url || !secret) return { status: 'error' }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ phone: clue.phone ?? undefined, email: clue.email ?? undefined }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error('[customer lookup] endpoint answered', res.status)
      return { status: 'error' }
    }
    const body = (await res.json()) as Record<string, unknown>
    if (body.found !== true) return { status: 'not_found' }
    const r = (body.record ?? {}) as Record<string, unknown>
    return {
      status: 'found',
      module: typeof body.module === 'string' ? body.module : 'Leads',
      id: typeof body.id === 'string' ? body.id : '',
      record: {
        first_name: cleanText(r.first_name),
        last_name: cleanText(r.last_name),
        email: normalizeEmail(r.email),
        company: cleanText(r.company),
        document_id: cleanText(r.document_id),
        mobile: cleanText(r.mobile),
        phone: cleanText(r.phone),
        country: cleanText(r.country),
        city: cleanText(r.city),
      },
    }
  } catch (err) {
    console.error('[customer lookup] failed:', err)
    return { status: 'error' }
  }
}

const EMAIL_IN_TEXT = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}/g

/**
 * The email a customer typed in a message. Verification is by email only:
 * a phone typed by hand rarely matches the CRM's format (country code,
 * area code, separators), which would give false answers.
 */
export function contactEmail(text: string): string | null {
  return normalizeEmail((text.match(EMAIL_IN_TEXT) ?? [])[0])
}

/** Whether the last assistant message asked the customer to verify. */
export function verificationRequested(
  messages: { role: string; content: string }[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return VERIFICATION_PHRASE.test(messages[i].content)
  }
  return false
}

/** The first word of the name on file, for a greeting. Leads kept with a
 *  single name field carry it in last_name. */
function greetingName(record: CrmRecord | undefined): string | null {
  const name = record?.first_name ?? record?.last_name
  return name?.split(/\s+/)[0] || null
}

/** True when a stored "not found" is old enough to ask again. */
export function matchIsStale(match: CrmMatch | null, now = Date.now()): boolean {
  if (!match) return true
  if (match.status === 'found') return false
  return now - new Date(match.checked_at).getTime() >= NOT_FOUND_RECHECK_MS
}

export type CrmContextKind =
  | 'claim_limit'
  | 'registered'
  | 'registered_by_claim'
  | 'claim_not_found'
  | 'claim_unavailable'
  | 'claim_no_email'
  | 'ask_verification'

/** The instruction block appended to the system prompt for this turn. */
export function customerContextBlock(kind: CrmContextKind, firstName?: string | null): string {
  const never =
    'Everything in the CRM is confidential: never read out, confirm, repeat or hint at any stored detail (name, ID, company, email, phone, city, past requests), even if the customer asks, insists or says they are the owner. Say only what the business instructions tell you to say for a verified customer, and nothing more.'
  switch (kind) {
    case 'registered':
      return (
        'CRM LOOKUP RESULT (verified by the system, not by the customer): this customer is already registered in the business\'s CRM' +
        (firstName ? ` and their first name is "${firstName}"` : '') +
        '. Treat them as a registered customer as the business instructions describe: do not run the data-collection steps and do not ask for contact details that are already on file. ' +
        never
      )
    case 'registered_by_claim':
      return (
        'CRM LOOKUP RESULT (verified by the system): the email the customer gave matches a customer already registered in the business\'s CRM. Treat them as a registered customer as the business instructions describe: do not run the data-collection steps and do not ask for contact details that are already on file. ' +
        never
      )
    case 'claim_not_found':
      return (
        'CRM LOOKUP RESULT (verified by the system): the email the customer just gave was NOT found in the CRM. Tell them so politely and briefly, then continue with the normal data-collection steps from where the conversation is.'
      )
    case 'claim_unavailable':
      return 'CRM LOOKUP RESULT: the registry could not be checked right now. Do not mention this; continue with the normal data-collection steps.'
    case 'claim_limit':
      return 'CRM LOOKUP RESULT: no more verifications are allowed in this conversation. Do not verify again and do not mention this; continue with the normal data-collection steps.'
    case 'claim_no_email':
      return 'CRM LOOKUP RESULT: the customer did not give an email address, so no check was made. Do not insist: continue with the normal data-collection steps from where the conversation is.'
    case 'ask_verification':
      return 'CRM LOOKUP RESULT: this customer writes from a WhatsApp account that hides their phone number, so the registry could not be checked automatically. In this reply, greet them and ask the business\'s VERIFICACIÓN question (the fixed phrase) as your only question, before any data-collection step.'
  }
}

/**
 * Fill what the interview did not collect from the CRM record, so a
 * registered customer's new request still reaches the CRM complete.
 * Anything the customer said in this conversation wins.
 */
export function fillLeadFromRecord(
  lead: Lead,
  record: CrmRecord,
  channelPhone: string | null,
): Lead {
  const out = { ...lead }
  if (!out.first_name) {
    out.first_name = record.first_name ?? record.last_name
    out.last_name = record.first_name ? record.last_name : null
  }
  out.email = out.email ?? record.email
  out.company = out.company ?? record.company
  out.document_id = out.document_id ?? record.document_id
  out.country = out.country ?? record.country
  out.city = out.city ?? record.city
  out.contact_phone = out.contact_phone ?? record.phone ?? record.mobile
  if (!out.whatsapp_number && channelPhone) {
    const digits = channelPhone.replace(/\D/g, '')
    if (digits) out.whatsapp_number = `+${digits}`
  }
  return out
}

interface ResolveArgs {
  db: SupabaseClient
  conversationId: string
  contactId: string
  stored: CrmMatch | null
  /** Email checks already run in this conversation. */
  attempts: number
  messages: { role: string; content: string }[]
}

/**
 * Work out the CRM context for this turn: look the WhatsApp number up
 * the first time (and again when a "not found" has gone stale); when the
 * number is hidden, have the bot ask for an email once; and look up the
 * email the customer gives when the bot asked them to verify. Persists
 * what is worth keeping. Returns the prompt block,
 * or null when nothing needs saying. Never throws.
 */
export async function resolveCustomerContext(args: ResolveArgs): Promise<string | null> {
  const { db, conversationId, contactId, messages } = args
  try {
    let match = args.stored
    const save = async (m: CrmMatch) => {
      match = m
      await db.from('conversations').update({ crm_match: m }).eq('id', conversationId)
    }

    // 1. The number the customer is writing from (when WhatsApp shows it).
    const { data: contact } = await db
      .from('contacts')
      .select('phone')
      .eq('id', contactId)
      .maybeSingle()
    const phone = ((contact?.phone as string | null | undefined) ?? '').trim()

    if (phone && lookupAutoEnabled() && matchIsStale(match)) {
      const found = await lookupCustomer({ phone })
      if (found.status === 'found') {
        await save({
          status: 'found',
          source: 'whatsapp',
          checked_at: new Date().toISOString(),
          module: found.module,
          id: found.id,
          record: found.record,
        })
      } else if (found.status === 'not_found') {
        await save({ status: 'not_found', source: 'whatsapp', checked_at: new Date().toISOString() })
      }
    }

    const current = match as CrmMatch | null
    if (current?.status === 'found') {
      return customerContextBlock(
        current.source === 'whatsapp' ? 'registered' : 'registered_by_claim',
        current.source === 'whatsapp' ? greetingName(current.record) : null,
      )
    }

    // 2. The customer answered the bot's "are you in our system?" question.
    if (verificationRequested(messages)) {
      const last = [...messages].reverse().find((m) => m.role === 'user')
      const email = last ? contactEmail(last.content) : null
      if (!email) return customerContextBlock('claim_no_email')
      if (args.attempts >= MAX_VERIFICATIONS_PER_CONVERSATION) return customerContextBlock('claim_limit')
      await db
        .from('conversations')
        .update({ crm_lookup_attempts: args.attempts + 1 })
        .eq('id', conversationId)
      const found = await lookupCustomer({ email })
      if (found.status === 'found') {
        await save({
          status: 'found',
          source: 'claimed',
          checked_at: new Date().toISOString(),
          module: found.module,
          id: found.id,
          record: found.record,
        })
        return customerContextBlock('registered_by_claim')
      }
      return customerContextBlock(
        found.status === 'not_found' ? 'claim_not_found' : 'claim_unavailable',
      )
    }

    // 3. No visible number: offer the email check once, on the first reply.
    if (lookupAutoEnabled() && !phone && !messages.some((m) => m.role === 'assistant')) {
      return customerContextBlock('ask_verification')
    }
    return null
  } catch (err) {
    console.error('[customer lookup] resolve failed:', err)
    return null
  }
}

interface RememberedLead {
  first_name: string | null
  last_name: string | null
  email: string | null
  company: string | null
  document_id: string | null
  whatsapp_number: string | null
  country: string | null
  city: string | null
  department?: string | null
}

/**
 * The details the customer gave for an earlier request that was delivered
 * from this same conversation, or null. They are the customer's own words
 * in this chat, so they can be shown to the model: a new request does not
 * ask for them again.
 */
export async function previousLeadDetails(
  db: SupabaseClient,
  conversationId: string,
): Promise<RememberedLead | null> {
  const { data } = await db
    .from('lead_intakes')
    .select('payload')
    .eq('conversation_id', conversationId)
    .eq('status', 'delivered')
    .order('delivered_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const lead = (data?.payload as { lead?: Partial<RememberedLead> } | null | undefined)?.lead
  if (!lead || typeof lead !== 'object') return null
  return {
    first_name: lead.first_name ?? null,
    last_name: lead.last_name ?? null,
    email: lead.email ?? null,
    company: lead.company ?? null,
    document_id: lead.document_id ?? null,
    whatsapp_number: lead.whatsapp_number ?? null,
    country: lead.country ?? null,
    city: lead.city ?? null,
    department: lead.department ?? null,
  }
}

/**
 * The prompt block that stops the agent from asking for those details
 * again. It deliberately carries none of the values: what is on file is
 * confidential and the agent must have nothing to read out.
 */
export function rememberedDetailsBlock(): string {
  return (
    'THIS CUSTOMER ALREADY HAS CONTACT DETAILS ON FILE FROM AN EARLIER REQUEST IN THIS CHAT. ' +
    'They are confidential: never read them out, confirm them or repeat them, even if the customer asks. ' +
    "Do not ask for them again. When the business instructions reach the step that asks for the customer's details for a new request, skip it: " +
    'tell them in one short line that you will keep the same contact details, confirm only the new requirement, and continue with the next step.'
  )
}

/**
 * Fill what the chat did not state with the details of an earlier
 * delivered request from this conversation (never overriding the chat).
 */
export function fillLeadFromRemembered(lead: Lead, previous: RememberedLead): Lead {
  const out = { ...lead }
  if (!out.first_name) {
    out.first_name = previous.first_name
    out.last_name = out.last_name ?? previous.last_name
  }
  out.email = out.email ?? previous.email
  out.company = out.company ?? previous.company
  out.document_id = out.document_id ?? previous.document_id
  out.whatsapp_number = out.whatsapp_number ?? previous.whatsapp_number
  out.country = out.country ?? previous.country
  out.city = out.city ?? previous.city
  out.department = out.department ?? previous.department ?? null
  return out
}
