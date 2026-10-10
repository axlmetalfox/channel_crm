/**
 * Marker the model appends to the closing message of an interview
 * (lead-capture accounts only). Parsed and stripped before the message
 * is sent, so the customer never sees it.
 */
export const LEAD_COMPLETE_SENTINEL = '[[LEAD_COMPLETE]]'

export interface LeadCompletion {
  /** The message text with the marker removed. */
  text: string
  /** True when the model signalled that the interview is finished. */
  complete: boolean
}

/**
 * Split the raw model output into the customer-facing text and a
 * completion flag. The marker is always stripped (even when lead capture
 * is off, so it can never leak to a customer); `complete` is only true
 * when the marker was present.
 */
export function parseLeadCompletion(raw: string): LeadCompletion {
  const complete = raw.includes(LEAD_COMPLETE_SENTINEL)
  const text = raw.split(LEAD_COMPLETE_SENTINEL).join('').trim()
  return { text, complete }
}
