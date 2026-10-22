import { describe, it, expect } from 'vitest'
import { STALE_AFTER_MS, summarizeChannel } from './health-report'

const NOW = Date.parse('2026-10-22T18:00:00.000Z')
const fresh = new Date(NOW - 60_000).toISOString()
const old = new Date(NOW - STALE_AFTER_MS - 60_000).toISOString()

describe('summarizeChannel', () => {
  it('reports a connected number as healthy (200)', () => {
    expect(summarizeChannel([{ connection_status: 'connected', connection_checked_at: fresh }], NOW)).toEqual({ word: 'connected', http: 200 })
  })

  it('makes the monitor go red (503) when the number is disconnected', () => {
    expect(summarizeChannel([{ connection_status: 'disconnected', connection_checked_at: fresh }], NOW)).toEqual({ word: 'disconnected', http: 503 })
  })

  it('also goes red when the watcher itself stopped (no recent reading)', () => {
    expect(summarizeChannel([{ connection_status: 'connected', connection_checked_at: old }], NOW)).toEqual({ word: 'stale', http: 503 })
    expect(summarizeChannel([{ connection_status: 'connected', connection_checked_at: null }], NOW)).toEqual({ word: 'stale', http: 503 })
  })

  it('a disconnected number wins over a stale one', () => {
    expect(
      summarizeChannel(
        [
          { connection_status: 'connected', connection_checked_at: old },
          { connection_status: 'disconnected', connection_checked_at: fresh },
        ],
        NOW,
      ).word,
    ).toBe('disconnected')
  })

  it('does not alarm for an unread-but-recent state or when nothing is configured', () => {
    expect(summarizeChannel([{ connection_status: 'unknown', connection_checked_at: fresh }], NOW)).toEqual({ word: 'unknown', http: 200 })
    expect(summarizeChannel([], NOW)).toEqual({ word: 'not_configured', http: 200 })
  })
})
