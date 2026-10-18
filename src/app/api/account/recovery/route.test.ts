import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  saved: null as Record<string, unknown> | null,
  row: {
    recovery_enabled: true,
    recovery_after_minutes: 120,
    recovery_message: 'Estoy muy atento',
  } as Record<string, unknown> | null,
  updated: [{ account_id: 'acct-1' }] as unknown[],
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
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({ data: h.updated, error: null }).then(ok)
      return b
    },
  }),
}))

import { GET, POST } from './route'

const post = (body: unknown) =>
  POST(new Request('https://x/api/account/recovery', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  h.saved = null
  h.updated = [{ account_id: 'acct-1' }]
  h.requireRole.mockResolvedValue({ accountId: 'acct-1' })
})

describe('/api/account/recovery', () => {
  it('reads the rule', async () => {
    expect(await (await GET()).json()).toEqual({
      configured: true,
      enabled: true,
      after_minutes: 120,
      message: 'Estoy muy atento',
    })
  })

  it('reports an account without an AI agent', async () => {
    h.row = null
    expect(await (await GET()).json()).toEqual({ configured: false })
    h.row = { recovery_enabled: true, recovery_after_minutes: 120, recovery_message: 'Estoy muy atento' }
  })

  it('saves minutes as given and hours converted, with the message trimmed', async () => {
    expect((await post({ enabled: true, value: 45, unit: 'minutes', message: ' Hola ' })).status).toBe(200)
    expect(h.saved).toEqual({
      recovery_enabled: true,
      recovery_after_minutes: 45,
      recovery_message: 'Hola',
    })
    await post({ enabled: true, value: 2, unit: 'hours', message: 'Hola' })
    expect(h.saved).toMatchObject({ recovery_after_minutes: 120 })
  })

  it('rejects waits outside 10 minutes to 23 hours or malformed', async () => {
    for (const bad of [
      { value: 9, unit: 'minutes' },
      { value: 24, unit: 'hours' },
      { value: 1.5, unit: 'hours' },
      { value: 10, unit: 'seconds' },
      { value: 'x', unit: 'minutes' },
    ]) {
      expect((await post({ enabled: true, message: 'Hola', ...bad })).status).toBe(400)
    }
    expect(h.saved).toBeNull()
  })

  it('needs a message to turn it on, but can save it off without one', async () => {
    const res = await post({ enabled: true, value: 2, unit: 'hours', message: '  ' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('message_required')
    expect((await post({ enabled: false, value: 2, unit: 'hours', message: '' })).status).toBe(200)
    expect(h.saved).toMatchObject({ recovery_enabled: false, recovery_message: null })
  })

  it('rejects a message over 500 characters', async () => {
    const res = await post({ enabled: true, value: 2, unit: 'hours', message: 'x'.repeat(501) })
    expect(res.status).toBe(400)
    expect(h.saved).toBeNull()
  })

  it('asks to set up the agent when there is no AI config to update', async () => {
    h.updated = []
    const res = await post({ enabled: true, value: 2, unit: 'hours', message: 'Hola' })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_configured')
  })

  it('is admin only', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await post({ enabled: true, value: 10, unit: 'minutes', message: 'Hola' })).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
  })
})
