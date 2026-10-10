/**
 * Pure helpers that clean what the extraction model returned before it
 * is sent to a CRM. Models are good at pulling values out of a chat and
 * bad at formatting them consistently, so format is enforced here.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Trim and collapse whitespace; null for empty / non-string input. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const out = value.replace(/\s+/g, ' ').trim()
  return out || null
}

/** Lower-cased, validated email; null when it doesn't look like one. */
export function normalizeEmail(value: unknown): string | null {
  const v = cleanText(value)?.toLowerCase().replace(/[.,;]+$/, '')
  return v && EMAIL_RE.test(v) ? v : null
}

/**
 * E.164 phone (`+573112580000`) or null. Accepts a leading `+` or `00`
 * international prefix; without either, a number of 11–15 digits is
 * assumed to already include its country code. A short national number
 * can't be resolved to a country here, so it returns null.
 */
export function normalizeE164(value: unknown): string | null {
  const raw = cleanText(value)
  if (!raw) return null
  const hasPlus = raw.startsWith('+')
  let digits = raw.replace(/\D/g, '')
  if (!hasPlus && digits.startsWith('00')) digits = digits.slice(2)
  else if (!hasPlus && (digits.length < 11 || digits.length > 15)) return null
  if (digits.length < 8 || digits.length > 15) return null
  return `+${digits}`
}

/**
 * A secondary contact phone. Prefer E.164; when the customer gave a
 * national number we can't place, keep the digits as typed rather than
 * dropping a number a salesperson can still dial.
 */
export function normalizeContactPhone(value: unknown): string | null {
  const e164 = normalizeE164(value)
  if (e164) return e164
  const digits = cleanText(value)?.replace(/\D/g, '')
  return digits && digits.length >= 7 && digits.length <= 15 ? digits : null
}
