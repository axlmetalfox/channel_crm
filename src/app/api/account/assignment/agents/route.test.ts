import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  update: null as Record<string, unknown> | null,
  filters: [] as [string, unknown][],
  found: true,
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
      b.update = (v: Record<string, unknown>) => ((h.update = v), b)
      b.eq = (c: string, v: unknown) => (h.filters.push([c, v]), b)
      b.select = () => Promise.resolve({ data: h.found ? [{ user_id: 'u1' }] : [], error: null })
      return b
    },
  }),
}))

import { POST } from './route'

const post = (body: unknown) =>
  POST(new Request('https://x/api/account/assignment/agents', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  h.update = null
  h.filters = []
  h.found = true
  h.requireRole.mockResolvedValue({ accountId: 'acct-1' })
})

describe('/api/account/assignment/agents', () => {
  it('takes an agent out of the rotation and back in, scoped to the account and the agent role', async () => {
    expect((await post({ user_id: 'u1', available: false })).status).toBe(200)
    expect(h.update).toEqual({ available_for_assignment: false })
    expect(h.filters).toEqual([
      ['account_id', 'acct-1'],
      ['user_id', 'u1'],
      ['account_role', 'agent'],
    ])
    await post({ user_id: 'u1', available: true })
    expect(h.update).toEqual({ available_for_assignment: true })
  })

  it('rejects a malformed body and an unknown agent', async () => {
    expect((await post({ user_id: 'u1' })).status).toBe(400)
    expect((await post({ available: true })).status).toBe(400)
    expect(h.update).toBeNull()
    h.found = false
    expect((await post({ user_id: 'nobody', available: true })).status).toBe(404)
  })

  it('is admin only', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post({ user_id: 'u1', available: true })).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
  })
})
