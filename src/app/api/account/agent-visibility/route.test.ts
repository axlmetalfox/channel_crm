import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  saved: null as Record<string, unknown> | null,
  row: { agents_see_only_assigned: false } as Record<string, unknown> | null,
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
  POST(new Request('https://x/api/account/agent-visibility', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  h.saved = null
  h.row = { agents_see_only_assigned: false }
  h.requireRole.mockResolvedValue({ accountId: 'acct-1' })
})

describe('/api/account/agent-visibility', () => {
  it('reads the setting, off unless explicitly on', async () => {
    expect(await (await GET()).json()).toEqual({ enabled: false })
    h.row = { agents_see_only_assigned: true }
    expect(await (await GET()).json()).toEqual({ enabled: true })
  })

  it('saves the setting', async () => {
    expect((await post({ enabled: true })).status).toBe(200)
    expect(h.saved).toEqual({ agents_see_only_assigned: true })
    await post({ enabled: false })
    expect(h.saved).toEqual({ agents_see_only_assigned: false })
  })

  it('rejects anything that is not a boolean', async () => {
    for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }]) {
      expect((await post(bad)).status).toBe(400)
    }
    expect(h.saved).toBeNull()
  })

  it('is admin only', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post({ enabled: true })).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
  })
})
