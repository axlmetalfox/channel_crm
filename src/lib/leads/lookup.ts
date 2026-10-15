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

/** The bot's question that starts a verification; matched in its last
 *  message to know the customer's next message is the answer. */
export const VERIFICATION_PHRASE = /encuentras en nuestro sistema/i

export interface CrmRecord {
  first_name: string | null
  last_name: string | null
  email: string | null
  company: string | null
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
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{8,}\d/g

/** Emails and phone numbers a customer typed in a message. */
export function contactClues(text: string): { email: string | null; phone: string | null } {
  const email = normalizeEmail((text.match(EMAIL_IN_TEXT) ?? [])[0])
  let phone: string | null = null
  for (const candidate of text.replace(EMAIL_IN_TEXT, ' ').match(PHONE_IN_TEXT) ?? []) {
    const digits = candidate.replace(/\D/g, '')
    if (digits.length >= 10 && digits.length <= 15) {
      phone = digits
      break
    }
  }
  return { email, phone }
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

/** True when a stored "not found" is old enough to ask again. */
export function matchIsStale(match: CrmMatch | null, now = Date.now()): boolean {
  if (!match) return true
  if (match.status === 'found') return false
  return now - new Date(match.checked_at).getTime() >= NOT_FOUND_RECHECK_MS
}

export type CrmContextKind = 'registered' | 'registered_by_claim' | 'claim_not_found' | 'claim_unavailable'

/** The instruction block appended to the system prompt for this turn. */
export function customerContextBlock(kind: CrmContextKind, firstName?: string | null): string {
  const never =
    'Never read out, confirm or hint at any stored detail (name, company, email, phone, city or past requests): only say whether the person is registered.'
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
        'CRM LOOKUP RESULT (verified by the system): the email or phone number the customer gave matches a customer already registered in the business\'s CRM. Treat them as a registered customer as the business instructions describe: do not run the data-collection steps and do not ask for contact details that are already on file. ' +
        never
      )
    case 'claim_not_found':
      return (
        'CRM LOOKUP RESULT (verified by the system): the email or phone number the customer just gave was NOT found in the CRM. Tell them so politely and briefly, then continue with the normal data-collection steps from where the conversation is.'
      )
    case 'claim_unavailable':
      return 'CRM LOOKUP RESULT: the registry could not be checked right now. Do not mention this; continue with the normal data-collection steps.'
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
  messages: { role: string; content: string }[]
}

/**
 * Work out the CRM context for this turn: look the WhatsApp number up
 * the first time (and again when a "not found" has gone stale), and
 * run a lookup on what the customer just typed when the bot asked them
 * to verify. Persists what is worth keeping. Returns the prompt block,
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

    // 1. The number the customer is writing from.
    if (matchIsStale(match)) {
      const { data: contact } = await db
        .from('contacts')
        .select('phone')
        .eq('id', contactId)
        .maybeSingle()
      const phone = (contact?.phone as string | null | undefined) ?? null
      if (phone) {
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
    }

    const current = match as CrmMatch | null
    if (current?.status === 'found') {
      return customerContextBlock(
        current.source === 'whatsapp' ? 'registered' : 'registered_by_claim',
        current.source === 'whatsapp' ? current.record?.first_name : null,
      )
    }

    // 2. The customer answered the bot's "are you in our system?" question.
    if (verificationRequested(messages)) {
      const last = [...messages].reverse().find((m) => m.role === 'user')
      const clues = last ? contactClues(last.content) : { email: null, phone: null }
      if (clues.email || clues.phone) {
        const found = await lookupCustomer(clues)
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
    }
    return null
  } catch (err) {
    console.error('[customer lookup] resolve failed:', err)
    return null
  }
}
