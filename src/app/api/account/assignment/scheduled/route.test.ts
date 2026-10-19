import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  saved: null as Record<string, unknown> | null,
  account: {
    id: 'acct-1',
    auto_assign_after_minutes: 60,
    auto_assign_cursor: null,
    auto_assign_max_age_days: 7,
    auto_assign_batch_per_agent: 3,
    auto_assign_once_at: '2026-10-19T19:30:00+00:00',
    auto_assign_once_result: null,
  } as Record<string, unknown> | null,
  agents: [
    { user_id: 'u1', full_name: 'Elcy', available_for_assignment: true },
    { user_id: 'u2', full_name: 'Carolina', available_for_assignment: false },
  ],
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 403 }),
}))
vi.mock('@/lib/conversations/auto-assign', () => ({
  countEligible: vi.fn(async () => 181),
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.maybeSingle = () => Promise.resolve({ data: h.account, error: null })
      b.order = () => Promise.resolve({ data: table === 'profiles' ? h.agents : [], error: null })
      b.update = (v: Record<string, unknown>) => {
        h.saved = v
        return b
      }
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok)
      return b
    },
  }),
}))

import { GET, POST } from './route'

const post = (body: unknown) =>
  POST(new Request('https://x/api/account/assignment/scheduled', { method: 'POST', body: JSON.stringify(body) }))
const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  h.saved = null
  h.requireRole.mockResolvedValue({ accountId: 'acct-1' })
})

describe('/api/account/assignment/scheduled', () => {
  it('reads the schedule, how many chats qualify now and who would receive them', async () => {
    expect(await (await GET()).json()).toEqual({
      at: '2026-10-19T19:30:00+00:00',
      result: null,
      eligible: 181,
      agents: [
        { user_id: 'u1', name: 'Elcy', available: true },
        { user_id: 'u2', name: 'Carolina', available: false },
      ],
      after_minutes: 60,
      max_age_days: 7,
    })
  })

  it('schedules a future moment and clears the previous result', async () => {
    const at = inHours(12)
    expect((await post({ at })).status).toBe(200)
    expect(h.saved).toEqual({ auto_assign_once_at: new Date(at).toISOString(), auto_assign_once_result: null })
  })

  it('cancels with null', async () => {
    expect((await post({ at: null })).status).toBe(200)
    expect(h.saved).toEqual({ auto_assign_once_at: null })
  })

  it('rejects a past, far-away or malformed time', async () => {
    for (const bad of [{ at: inHours(-2) }, { at: inHours(24 * 90) }, { at: 'mañana' }, {}, { at: 12 }]) {
      expect((await post(bad)).status).toBe(400)
    }
    expect(h.saved).toBeNull()
  })

  it('is admin only', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post({ at: inHours(1) })).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
  })
})
