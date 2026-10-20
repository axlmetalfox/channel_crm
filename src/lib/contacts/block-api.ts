import type { BlockReason, WhatsAppBlockOutcome } from './block-reasons'

interface BlockResponse {
  ok?: boolean
  whatsapp?: WhatsAppBlockOutcome
  error?: string
}

async function call(contactId: string, method: 'POST' | 'DELETE', body?: unknown): Promise<WhatsAppBlockOutcome> {
  const response = await fetch(`/api/contacts/${contactId}/block`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as BlockResponse
  if (!response.ok) throw new Error(data.error ?? 'Failed to update the block')
  return data.whatsapp ?? 'failed'
}

/** Block a contact; resolves with how it went on WhatsApp itself. */
export function blockContact(contactId: string, reason: BlockReason, note: string) {
  return call(contactId, 'POST', { reason, note: note.trim() || undefined })
}

/** Lift a block (admins and the owner only). */
export function unblockContact(contactId: string) {
  return call(contactId, 'DELETE')
}
