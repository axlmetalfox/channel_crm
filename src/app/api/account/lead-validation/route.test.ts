import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  saved: null as Record<string, unknown> | null,
  row: { validate_manual_leads: true } as Record<string, unknown> | null,
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
  POST(new Request('https://x/api/account/lead-validation', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  h.saved = null
  h.row = { validate_manual_leads: true }
  h.requireRole.mockResolvedValue({ accountId: 'acct-1' })
})

describe('/api/account/lead-validation', () => {
  it('reads the switch, on unless explicitly off', async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true })
    h.row = { validate_manual_leads: false }
    expect(await (await GET()).json()).toEqual({ enabled: false })
  })

  it('saves the switch', async () => {
    expect((await post({ enabled: false })).status).toBe(200)
    expect(h.saved).toEqual({ validate_manual_leads: false })
    await post({ enabled: true })
    expect(h.saved).toEqual({ validate_manual_leads: true })
  })

  it('rejects anything that is not a boolean', async () => {
    for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }]) {
      expect((await post(bad)).status).toBe(400)
    }
    expect(h.saved).toBeNull()
  })

  it('is admin only', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post({ enabled: false })).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
  })
})
