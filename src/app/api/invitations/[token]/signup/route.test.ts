import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  createUser: vi.fn(),
  rate: vi.fn(),
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc, auth: { admin: { createUser: h.createUser } } }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.rate,
  rateLimitResponse: () => new Response(JSON.stringify({ error: 'rate' }), { status: 429 }),
  RATE_LIMITS: { invitationSignup: { limit: 5, windowMs: 3_600_000 } },
}))

import { hashInviteToken } from '@/lib/auth/invitations'
import { POST } from './route'

const call = (body: unknown, token = 'tok-123') =>
  POST(
    new Request('https://x/api/invitations/tok-123/signup', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  )

const GOOD = { full_name: 'Luisa Álvarez', email: 'Luisa@Intertec.com.co', password: 'secret12' }

beforeEach(() => {
  vi.clearAllMocks()
  h.rate.mockReturnValue({ success: true })
  h.rpc.mockResolvedValue({ data: { ok: true }, error: null })
  h.createUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
})

describe('POST /api/invitations/[token]/signup', () => {
  it('creates a confirmed account for a valid invitation', async () => {
    const res = await call(GOOD)
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('peek_invitation', { p_token_hash: hashInviteToken('tok-123') })
    expect(h.createUser).toHaveBeenCalledWith({
      email: 'luisa@intertec.com.co',
      password: 'secret12',
      email_confirm: true,
      user_metadata: { full_name: 'Luisa Álvarez' },
    })
  })

  it('creates nothing for an invitation that is expired, used or unknown', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, reason: 'expired' }, error: null })
    const res = await call(GOOD)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_invite')
    expect(h.createUser).not.toHaveBeenCalled()
  })

  it('rejects bad input before touching the database', async () => {
    for (const bad of [
      { ...GOOD, email: 'nope' },
      { ...GOOD, password: '123' },
      { ...GOOD, full_name: '  ' },
    ]) {
      const res = await call(bad)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('invalid_input')
    }
    expect((await call('not json')).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createUser).not.toHaveBeenCalled()
  })

  it('tells an existing user to sign in instead', async () => {
    h.createUser.mockResolvedValue({
      data: null,
      error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
    })
    const res = await call(GOOD)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('email_exists')
  })

  it('is rate limited per IP', async () => {
    h.rate.mockReturnValue({ success: false })
    const res = await call(GOOD)
    expect(res.status).toBe(429)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
