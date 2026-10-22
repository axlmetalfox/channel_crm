import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ number: vi.fn(), account: vi.fn(), config: vi.fn() }))
vi.mock('./client', () => ({
  getWhatsAppNumberStatus: h.number,
  checkZernioAccount: h.account,
}))
vi.mock('./config', () => ({ loadZernioConfig: h.config }))

import { runChannelHealthCheck } from './health'

function fakeDb(row: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = []
  const db = {
    from() {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string) => {
        if (col === 'is_active') return Promise.resolve({ data: [row], error: null })
        return Promise.resolve({ error: null })
      }
      b.update = (v: Record<string, unknown>) => {
        updates.push(v)
        return { eq: () => Promise.resolve({ error: null }) }
      }
      return b
    },
  } as never
  return { db, updates }
}

const UP_ROW = {
  account_id: 'acct',
  connection_status: 'connected',
  connection_fail_count: 0,
  connection_down_since: null,
  connection_alerted_at: null,
}

beforeEach(() => {
  h.number.mockReset()
  h.account.mockReset()
  h.config.mockReset()
  h.config.mockResolvedValue({ apiKey: 'k', zernioAccountId: 'zacc' })
  h.account.mockResolvedValue({ inboundWebhookSubscribed: true })
})

describe('runChannelHealthCheck', () => {
  it('records a healthy number without alerting', async () => {
    h.number.mockResolvedValue({ phoneStatus: 'CONNECTED' })
    const { db, updates } = fakeDb(UP_ROW)
    const out = await runChannelHealthCheck(db)
    expect(out).toEqual({ accounts: 1, alerts: [] })
    expect(updates[0]).toMatchObject({ connection_status: 'connected', connection_fail_count: 0, connection_detail: 'CONNECTED' })
  })

  it('counts a first bad reading but does not alert yet', async () => {
    h.number.mockResolvedValue({ phoneStatus: 'DISCONNECTED' })
    const { db, updates } = fakeDb(UP_ROW)
    const out = await runChannelHealthCheck(db)
    expect(out.alerts).toEqual([])
    expect(updates[0]).toMatchObject({ connection_status: 'connected', connection_fail_count: 1, connection_detail: 'DISCONNECTED' })
  })

  it('alerts once when the second bad reading confirms the outage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.number.mockResolvedValue({ phoneStatus: 'DISCONNECTED' })
    const { db, updates } = fakeDb({ ...UP_ROW, connection_fail_count: 1, connection_down_since: '2026-10-22T13:00:00Z' })
    const out = await runChannelHealthCheck(db)
    expect(out.alerts).toEqual([{ accountId: 'acct', alert: 'down' }])
    expect(updates[0]).toMatchObject({ connection_status: 'disconnected', connection_down_since: '2026-10-22T13:00:00Z' })
  })

  it('does not decide anything when Zernio cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.number.mockRejectedValue(new Error('timeout'))
    const { db, updates } = fakeDb({ ...UP_ROW, connection_status: 'disconnected', connection_fail_count: 2, connection_alerted_at: '2026-10-22T13:05:00Z' })
    const out = await runChannelHealthCheck(db)
    expect(out.alerts).toEqual([])
    expect(updates[0]).toMatchObject({ connection_status: 'disconnected', connection_fail_count: 2 })
    expect(updates[0]).not.toHaveProperty('connection_detail')
  })

  it('says when the number is back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.number.mockResolvedValue({ phoneStatus: 'CONNECTED' })
    const { db } = fakeDb({ ...UP_ROW, connection_status: 'disconnected', connection_fail_count: 3, connection_down_since: 'x', connection_alerted_at: 'y' })
    expect((await runChannelHealthCheck(db)).alerts).toEqual([{ accountId: 'acct', alert: 'restored' }])
  })
})
