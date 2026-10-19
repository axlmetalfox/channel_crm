import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  limit: { success: true } as { success: boolean },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: unknown) =>
    new Response(JSON.stringify({ error: String(err) }), { status: 403 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => h.limit,
  rateLimitResponse: () => new Response('{}', { status: 429 }),
  RATE_LIMITS: { send: {} },
}))

import { POST } from './route'

const CONV = '3bb6ebbd-461f-4ed6-b81f-62133e3bbd5b'
const ELCY = 'c9acce12-ff4e-448d-abaf-3fbd5aef7e14'
const CAROLINA = '88a7e629-b1a3-41b7-bd6c-a83897e5aba3'

const post = (body: unknown, id = CONV) =>
  POST(
    new Request('https://x/api/conversations/x/transfer', { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  )

beforeEach(() => {
  vi.clearAllMocks()
  h.limit = { success: true }
  h.rpc.mockResolvedValue({ error: null })
  h.requireRole.mockResolvedValue({ supabase: { rpc: h.rpc }, userId: ELCY })
})

describe('POST /api/conversations/[id]/transfer', () => {
  it('hands the conversation to a colleague through the database function', async () => {
    const res = await post({ to_user_id: CAROLINA })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ assigned_agent_id: CAROLINA })
    expect(h.rpc).toHaveBeenCalledWith('transfer_conversation', { p_conversation_id: CONV, p_to_user_id: CAROLINA })
    expect(h.requireRole).toHaveBeenCalledWith('agent')
  })

  it('releases the conversation with null', async () => {
    const res = await post({ to_user_id: null })
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('transfer_conversation', { p_conversation_id: CONV, p_to_user_id: null })
  })

  it('rejects a body without a valid target and a malformed conversation id', async () => {
    for (const bad of [{}, { to_user_id: 'nobody' }, { to_user_id: 5 }, null]) {
      expect((await post(bad)).status).toBe(400)
    }
    expect((await post({ to_user_id: CAROLINA }, 'not-a-uuid')).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['not_found', 404, 'not_found'],
    ['not_owner', 403, 'not_owner'],
    ['forbidden', 403, 'forbidden'],
    ['invalid_target', 400, 'invalid_target'],
    ['boom', 500, 'failed'],
  ])('maps the database error %s to %i', async (message, status, code) => {
    h.rpc.mockResolvedValue({ error: { message } })
    const res = await post({ to_user_id: CAROLINA })
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
  })

  it('is rate limited and needs the agent role', async () => {
    h.limit = { success: false }
    expect((await post({ to_user_id: CAROLINA })).status).toBe(429)
    h.limit = { success: true }
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post({ to_user_id: CAROLINA })).status).toBe(403)
  })
})
