/**
 * What an external monitor (Uptime Kuma) is told about the WhatsApp channel:
 * one word, and an HTTP status that makes the monitor go red when something
 * is wrong. No customer data, no account detail.
 */

export type HealthWord = 'connected' | 'disconnected' | 'stale' | 'unknown' | 'not_configured'

/** The sweep refreshes the reading every 5 minutes; older than this means the sweep itself stopped. */
export const STALE_AFTER_MS = 20 * 60_000

export interface ChannelRow {
  connection_status: string | null
  connection_checked_at: string | null
}

/**
 * Worst case across the account's active numbers: disconnected, then stale
 * (the watcher stopped), then unknown, then connected. No active number is
 * "not_configured" (and not an error: nothing to watch).
 */
export function summarizeChannel(rows: ChannelRow[], nowMs: number): { word: HealthWord; http: number } {
  if (rows.length === 0) return { word: 'not_configured', http: 200 }
  if (rows.some((r) => r.connection_status === 'disconnected')) return { word: 'disconnected', http: 503 }
  const stale = rows.some((r) => {
    const t = r.connection_checked_at ? Date.parse(r.connection_checked_at) : NaN
    return !Number.isFinite(t) || nowMs - t > STALE_AFTER_MS
  })
  if (stale) return { word: 'stale', http: 503 }
  if (rows.some((r) => r.connection_status !== 'connected')) return { word: 'unknown', http: 200 }
  return { word: 'connected', http: 200 }
}
