// Client-safe pieces of the contact block (no server imports).

/** What happened on WhatsApp itself when a contact was blocked or unblocked. */
export type WhatsAppBlockOutcome =
  /** WhatsApp accepted it. */
  | 'done'
  /** The person has not written in the last 24 hours: Meta refuses to block
   *  them. They stay blocked inside TUYO. */
  | 'window_expired'
  /** Zernio or Meta refused or could not be reached. */
  | 'failed'
  /** The contact has no visible number (a WhatsApp username account). */
  | 'no_number'
  /** The account does not use Zernio. */
  | 'no_channel'

export const BLOCK_REASONS = ['offensive', 'fake', 'other'] as const
export type BlockReason = (typeof BLOCK_REASONS)[number]

export function isBlockReason(value: unknown): value is BlockReason {
  return typeof value === 'string' && (BLOCK_REASONS as readonly string[]).includes(value)
}
