import type { Lead } from './schema'

/** Digits only. */
function digitsOf(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

/**
 * Whether two numbers are the same line: same digits, or the same last ten
 * (one with the country code, the other without).
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = digitsOf(a)
  const y = digitsOf(b)
  if (!x || !y) return false
  if (x === y) return true
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10)
}

/**
 * The WhatsApp number of a lead is the one the customer wrote from: people
 * mistype theirs when asked ("my WhatsApp is…"), and a wrong number sent to
 * the CRM means the advisor calls nobody. When the chat's number is known it
 * always wins; when the customer had typed a different one, `reported` keeps
 * what they typed so the CRM record can say so. Customers whose number
 * WhatsApp hides (no channel number) are left as they are.
 */
export function reconcileWhatsApp(
  lead: Lead,
  channelPhone: string | null | undefined,
): { lead: Lead; reported: string | null } {
  const digits = digitsOf(channelPhone)
  if (!digits) return { lead, reported: null }
  const channel = `+${digits}`
  const typed = lead.whatsapp_number
  const reported = typed && !samePhone(typed, channel) ? typed : null
  return { lead: { ...lead, whatsapp_number: channel }, reported }
}
