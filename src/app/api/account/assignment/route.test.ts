import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  saved: null as Record<string, unknown> | null,
  row: { auto_assign_enabled: true, auto_assign_after_minutes: 90 } as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 403 }),
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = () => Promise.resolve({ data: h.row, error: null })
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
  POST(new Request('https://x/api/account/assignment', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  h.saved = null
  h.requireRole.mockResolvedValue({ accountId: 'acct-1' })
})

describe('/api/account/assignment', () => {
  it('reads the rule', async () => {
    const res = await GET()
    expect(await res.json()).toEqual({ enabled: true, after_minutes: 90 })
  })

  it('saves minutes as given and hours converted to minutes', async () => {
    expect((await post({ enabled: true, value: 45, unit: 'minutes' })).status).toBe(200)
    expect(h.saved).toEqual({ auto_assign_enabled: true, auto_assign_after_minutes: 45 })
    await post({ enabled: false, value: 2, unit: 'hours' })
    expect(h.saved).toEqual({ auto_assign_enabled: false, auto_assign_after_minutes: 120 })
  })

  it('rejects waits that are too short, too long or malformed', async () => {
    for (const bad of [
      { enabled: true, value: 4, unit: 'minutes' },
      { enabled: true, value: 31 * 24, unit: 'hours' },
      { enabled: true, value: 1.5, unit: 'hours' },
      { enabled: true, value: 10, unit: 'seconds' },
      { enabled: true, value: 'x', unit: 'minutes' },
    ]) {
      expect((await post(bad)).status).toBe(400)
    }
    expect(h.saved).toBeNull()
  })

  it('is admin only', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post({ enabled: true, value: 10, unit: 'minutes' })).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
  })
})
