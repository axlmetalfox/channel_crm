import type { Lead } from './schema'

// ============================================================
// Proof that a lead's data came from the customer.
//
// An agent sending a lead by hand may correct what the form proposed, but
// only with a value the customer wrote in the chat (or said in a voice
// note, which is transcribed). Anything else is invented data, which is
// useless to the sales team and inflates the agent's conversion numbers.
//
// A value is accepted when it is
//   - the one the server proposed (read from the chat, the CRM record or
//     the number the chat runs on), or
//   - found in a message the CUSTOMER sent. Messages from agents and from
//     the AI never count.
// ============================================================

export const VERIFIED_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'company',
  'document_id',
  'whatsapp_number',
  'contact_phone',
  'country',
  'city',
  'department',
] as const
export type VerifiedField = (typeof VERIFIED_FIELDS)[number]

type Fields = Pick<Lead, Exclude<VerifiedField, 'department'>> & { department?: string | null }

/** Lower-case, no accents, punctuation turned into single spaces. */
function words(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim()
}

const digitsOf = (text: string) => text.replace(/\D/g, '')

/** National part of a phone: the last 10 digits when it is longer. */
function phoneCore(value: string): string {
  const d = digitsOf(value)
  return d.length > 10 ? d.slice(-10) : d
}

function sameValue(field: VerifiedField, a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  switch (field) {
    case 'whatsapp_number':
    case 'contact_phone':
      return phoneCore(a) === phoneCore(b)
    case 'document_id':
      return digitsOf(a) === digitsOf(b)
    case 'email':
      return a.toLowerCase() === b.toLowerCase()
    default:
      return words(a) === words(b)
  }
}

function inCustomerText(field: VerifiedField, value: string, customerTexts: string[]): boolean {
  switch (field) {
    case 'email': {
      const v = value.toLowerCase()
      return customerTexts.some((t) => t.toLowerCase().includes(v))
    }
    case 'whatsapp_number':
    case 'contact_phone': {
      const core = phoneCore(value)
      return core.length >= 7 && customerTexts.some((t) => digitsOf(t).includes(core))
    }
    case 'document_id': {
      const d = digitsOf(value)
      return d.length >= 5 && customerTexts.some((t) => digitsOf(t).includes(d))
    }
    default: {
      const tokens = words(value).split(' ').filter(Boolean)
      if (tokens.length === 0) return false
      const text = ` ${customerTexts.map(words).join(' ')} `
      return tokens.every((tok) => text.includes(` ${tok} `))
    }
  }
}

/**
 * The fields of `submitted` whose value is neither the one proposed in
 * `baseline` nor written by the customer. Emptying a field is always fine.
 */
export function unverifiedFields(
  submitted: Fields,
  baseline: Partial<Fields> | null,
  customerTexts: string[],
): VerifiedField[] {
  const bad: VerifiedField[] = []
  for (const field of VERIFIED_FIELDS) {
    const value = submitted[field]
    if (!value) continue
    if (sameValue(field, value, baseline?.[field] ?? null)) continue
    if (inCustomerText(field, value, customerTexts)) continue
    bad.push(field)
  }
  return bad
}

/** Fields an agent must have before a lead can be sent by hand. */
export const REQUIRED_MANUAL_FIELDS = [
  'first_name',
  'last_name',
  'whatsapp_number',
  'email',
  'city',
] as const

export function missingManualFields(lead: Pick<Lead, (typeof REQUIRED_MANUAL_FIELDS)[number]>): string[] {
  return REQUIRED_MANUAL_FIELDS.filter((f) => !lead[f])
}
