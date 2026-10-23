import { describe, it, expect } from 'vitest'
import { parseAdInsightRow } from '@/lib/zernio/client'
import { bogotaDay, isSyncDue } from './sync'

const NOW = new Date('2026-10-22T12:00:00Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

describe('isSyncDue', () => {
  it('is due when it never ran', () => {
    expect(isSyncDue(null, NOW)).toBe(true)
  })

  it('waits six hours after a success', () => {
    expect(isSyncDue({ last_synced_at: ago(60), last_attempt_at: ago(60) }, NOW)).toBe(false)
    expect(isSyncDue({ last_synced_at: ago(361), last_attempt_at: ago(361) }, NOW)).toBe(true)
  })

  it('retries a failed attempt after thirty minutes', () => {
    expect(isSyncDue({ last_synced_at: ago(600), last_attempt_at: ago(10) }, NOW)).toBe(false)
    expect(isSyncDue({ last_synced_at: ago(600), last_attempt_at: ago(31) }, NOW)).toBe(true)
  })
})

describe('bogotaDay', () => {
  it('uses the Bogotá calendar day', () => {
    expect(bogotaDay(new Date('2026-10-23T03:00:00Z'))).toBe('2026-10-22')
  })
})

describe('parseAdInsightRow', () => {
  it('reads spend, clicks and the conversations started', () => {
    const r = parseAdInsightRow({
      ad_id: '123',
      date_start: '2026-10-01',
      spend: '6689',
      impressions: '722',
      clicks: '21',
      actions: [
        { action_type: 'link_click', value: '1' },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' },
      ],
    })
    expect(r).toEqual({ platformAdId: '123', day: '2026-10-01', spend: 6689, impressions: 722, clicks: 21, conversationsStarted: 4 })
  })

  it('defaults to zero and skips rows without an ad or day', () => {
    expect(parseAdInsightRow({ ad_id: '1', date_start: '2026-10-02' })).toMatchObject({ spend: 0, conversationsStarted: 0 })
    expect(parseAdInsightRow({ date_start: '2026-10-02' })).toBeNull()
    expect(parseAdInsightRow({ ad_id: '1' })).toBeNull()
  })
})
