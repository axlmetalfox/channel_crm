// Sending one approved WhatsApp template to many conversations at once
// (re-engaging customers who went quiet). The sends go one at a time through
// the same endpoint as a single send, paced under its 60-per-minute limit,
// and the person can stop the run.

/** Most conversations one run may cover (each template is billed by Meta). */
export const BULK_TEMPLATE_MAX = 100

/** Pause between sends: the send endpoint allows 60 per minute per person. */
export const BULK_SEND_GAP_MS = 1100

/**
 * What {{1}} becomes for one customer: their name, tidied. A contact whose
 * "name" is just their number or a handle gets a neutral word instead.
 */
export function recipientName(
  contact: { name?: string | null; phone?: string | null } | null | undefined,
): string {
  const raw = (contact?.name ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return 'cliente'
  if (/^[+\d\s().-]+$/.test(raw) || raw.startsWith('@')) return 'cliente'
  const tidy = raw === raw.toUpperCase() || raw === raw.toLowerCase()
    ? raw
        .toLowerCase()
        .split(' ')
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ')
    : raw
  return tidy.slice(0, 40)
}

export interface BulkItem {
  conversationId: string
  name: string
}

export interface BulkOutcome {
  sent: number
  failed: { conversationId: string; reason: string }[]
  stopped: boolean
}

/**
 * Run `send` for each item in order. `onProgress` fires after every item;
 * `shouldStop` is checked before each send, so a stop request takes effect
 * after the current one. `sleep` is injectable for tests.
 */
export async function runBulkTemplate(args: {
  items: BulkItem[]
  send: (item: BulkItem) => Promise<{ ok: boolean; error?: string }>
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
  gapMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<BulkOutcome> {
  const { items, send, onProgress, shouldStop } = args
  const gap = args.gapMs ?? BULK_SEND_GAP_MS
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const outcome: BulkOutcome = { sent: 0, failed: [], stopped: false }

  for (let i = 0; i < items.length; i++) {
    if (shouldStop?.()) {
      outcome.stopped = true
      break
    }
    const item = items[i]
    try {
      const res = await send(item)
      if (res.ok) outcome.sent += 1
      else outcome.failed.push({ conversationId: item.conversationId, reason: res.error ?? 'error' })
    } catch (err) {
      outcome.failed.push({
        conversationId: item.conversationId,
        reason: err instanceof Error ? err.message : 'error',
      })
    }
    onProgress?.(i + 1, items.length)
    if (i < items.length - 1 && gap > 0) await sleep(gap)
  }
  return outcome
}
