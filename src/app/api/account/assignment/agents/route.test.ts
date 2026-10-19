import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  update: null as Record<string, unknown> | null,
  filters: [] as [string, unknown][],
  found: true,
  profile: { available_for_assignment: true, account_role: 'agent' } as Record<string, unknown> | null,
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
      b.select = () => b
      b.maybeSingle = () => Promise.resolve({ data: h.profile })
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: h.found ? [{ user_id: 'u1' }] : [], error: null }).then(ok)
      return b
    },
  }),
}))

import { GET, POST } from './route'

const post = (body: unknown) =>
  POST(new Request('https://x/api/account/assignment/agents', { method: 'POST', body: JSON.stringify(body) }))

const asAdmin = () => h.requireRole.mockResolvedValue({ accountId: 'acct-1', userId: 'admin-1', role: 'admin' })
const asAgent = () => h.requireRole.mockResolvedValue({ accountId: 'acct-1', userId: 'u1', role: 'agent' })

beforeEach(() => {
  vi.clearAllMocks()
  h.update = null
  h.filters = []
  h.found = true
  h.profile = { available_for_assignment: true, account_role: 'agent' }
  asAdmin()
})

describe('/api/account/assignment/agents', () => {
  it('lets an admin take any agent out of the rotation and back in', async () => {
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

  it('lets an agent change their own availability, with or without sending their id', async () => {
    asAgent()
    expect((await post({ available: false })).status).toBe(200)
    expect(h.filters).toContainEqual(['user_id', 'u1'])
    h.filters = []
    expect((await post({ user_id: 'u1', available: true })).status).toBe(200)
    expect(h.update).toEqual({ available_for_assignment: true })
  })

  it('refuses an agent changing someone else\'s availability', async () => {
    asAgent()
    const res = await post({ user_id: 'someone-else', available: false })
    expect(res.status).toBe(403)
    expect(h.update).toBeNull()
  })

  it('rejects a malformed body and an unknown agent', async () => {
    expect((await post({ user_id: 'u1' })).status).toBe(400)
    expect(h.update).toBeNull()
    h.found = false
    expect((await post({ user_id: 'nobody', available: true })).status).toBe(404)
  })

  it('needs at least the agent role', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post({ available: true })).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('agent')
  })

  it('reports the caller\'s own availability and whether they are in the rotation', async () => {
    asAgent()
    expect(await (await GET()).json()).toEqual({ available: true, eligible: true })
    h.profile = { available_for_assignment: false, account_role: 'admin' }
    expect(await (await GET()).json()).toEqual({ available: false, eligible: false })
  })
})
