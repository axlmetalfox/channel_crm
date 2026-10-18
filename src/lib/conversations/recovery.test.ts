import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  send: vi.fn(),
  zernio: vi.fn(),
}))

vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.send }))
vi.mock('@/lib/zernio/config', () => ({ loadZernioConfig: h.zernio }))

import { isQuietHour, runRecoveryNudges } from './recovery'

// 2026-10-19 is a Monday. Bogotá is UTC-5.
const at = (bogotaHour: number) => new Date(Date.UTC(2026, 9, 19, bogotaHour + 5, 0, 0))

describe('isQuietHour', () => {
  it('is quiet from 21:00 until 07:00 in Bogotá', () => {
    expect(isQuietHour(at(21))).toBe(true)
    expect(isQuietHour(at(23))).toBe(true)
    expect(isQuietHour(at(3))).toBe(true)
    expect(isQuietHour(at(6))).toBe(true)
  })
  it('is not quiet during the day', () => {
    expect(isQuietHour(at(7))).toBe(false)
    expect(isQuietHour(at(14))).toBe(false)
    expect(isQuietHour(at(20))).toBe(false)
  })
  it('follows the given time zone', () => {
    // 14:00 Bogotá is 21:00 in UTC+2.
    expect(isQuietHour(at(14), 'Europe/Madrid')).toBe(true)
  })
})

describe('runRecoveryNudges', () => {
  const state = {
    rules: [] as Record<string, unknown>[],
    candidates: [] as Record<string, unknown>[],
    taken: new Set<string>(),
    updates: [] as { id: string; values: Record<string, unknown> }[],
    rpcArgs: undefined as Record<string, unknown> | undefined,
  }

  function fakeDb() {
    return {
      rpc(_name: string, args: Record<string, unknown>) {
        state.rpcArgs = args
        return Promise.resolve({ data: state.candidates })
      },
      from(table: string) {
        let values: Record<string, unknown> | null = null
        const filters: Record<string, unknown> = {}
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'not']) b[m] = () => b
        b.eq = (c: string, v: unknown) => ((filters[c] = v), b)
        b.is = () => b
        b.update = (v: Record<string, unknown>) => ((values = v), b)
        b.then = (ok: (v: unknown) => unknown) => {
          if (table === 'ai_configs') return Promise.resolve({ data: state.rules }).then(ok)
          if (table === 'conversations' && values) {
            const id = filters.id as string
            if (state.taken.has(id)) return Promise.resolve({ data: [] }).then(ok)
            state.updates.push({ id, values })
            return Promise.resolve({ data: [{ id }] }).then(ok)
          }
          return Promise.resolve({ data: null }).then(ok)
        }
        return b
      },
    } as never
  }

  const rule = {
    account_id: 'acct-1',
    recovery_after_minutes: 120,
    recovery_message: '  Estoy muy atento para ayudarte  ',
    auto_reply_schedule: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    state.rules = [rule]
    state.candidates = [{ conversation_id: 'c1', contact_id: 'p1', previous_nudge_at: null }]
    state.taken = new Set()
    state.updates = []
    state.rpcArgs = undefined
    h.zernio.mockResolvedValue({ userId: 'u1' })
    h.send.mockResolvedValue(undefined)
  })

  it('sends the trimmed message once and records the nudge', async () => {
    const now = at(14)
    expect(await runRecoveryNudges(fakeDb(), now)).toEqual({ sent: 1 })
    expect(h.send).toHaveBeenCalledWith({
      accountId: 'acct-1',
      userId: 'u1',
      conversationId: 'c1',
      contactId: 'p1',
      text: 'Estoy muy atento para ayudarte',
      aiGenerated: true,
    })
    expect(state.updates).toEqual([{ id: 'c1', values: { recovery_nudge_at: now.toISOString() } }])
    expect(state.rpcArgs).toMatchObject({ p_account_id: 'acct-1', p_idle_minutes: 120 })
  })

  it('stays silent at night', async () => {
    expect(await runRecoveryNudges(fakeDb(), at(22))).toEqual({ sent: 0 })
    expect(h.send).not.toHaveBeenCalled()
    expect(state.rpcArgs).toBeUndefined()
  })

  it('stays silent while the AI agent is off duty', async () => {
    state.rules = [
      {
        ...rule,
        auto_reply_schedule: {
          timezone: 'America/Bogota',
          windows: [{ days: [0, 6], start: '00:00', end: '23:59' }],
        },
      },
    ]
    expect(await runRecoveryNudges(fakeDb(), at(14))).toEqual({ sent: 0 })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('does not send when another sweep already claimed the conversation', async () => {
    state.taken.add('c1')
    expect(await runRecoveryNudges(fakeDb(), at(14))).toEqual({ sent: 0 })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('gives the claim back when the send fails', async () => {
    h.send.mockRejectedValue(new Error('boom'))
    const now = at(14)
    expect(await runRecoveryNudges(fakeDb(), now)).toEqual({ sent: 0 })
    expect(state.updates.at(-1)).toEqual({ id: 'c1', values: { recovery_nudge_at: null } })
  })

  it('skips accounts without a connected Zernio number', async () => {
    h.zernio.mockResolvedValue(null)
    expect(await runRecoveryNudges(fakeDb(), at(14))).toEqual({ sent: 0 })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('skips a rule whose message is blank', async () => {
    state.rules = [{ ...rule, recovery_message: '   ' }]
    expect(await runRecoveryNudges(fakeDb(), at(14))).toEqual({ sent: 0 })
  })
})
