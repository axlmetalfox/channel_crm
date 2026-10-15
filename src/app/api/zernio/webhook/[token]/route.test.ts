import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signZernioBody } from '@/lib/zernio/signature'

const h = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  processInbound: vi.fn(),
  processStatus: vi.fn(),
  afterCallbacks: [] as (() => Promise<void>)[],
}))

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return { ...actual, after: (cb: () => Promise<void>) => h.afterCallbacks.push(cb) }
})
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/zernio/config', () => ({ loadZernioConfigByToken: h.loadConfig }))
vi.mock('@/lib/zernio/inbound', () => ({
  processZernioInbound: h.processInbound,
  processZernioStatus: h.processStatus,
}))

import { POST } from './route'

const SECRET = 'whsec_test'
const CONFIG = {
  id: 'z1',
  accountId: 'acct-1',
  userId: 'user-1',
  apiKey: 'k',
  zernioAccountId: 'zacc',
  webhookToken: 'tok',
  webhookSecret: SECRET,
  isActive: true,
}

async function call(body: unknown, opts: { signature?: string | null; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body)
  const signature = opts.signature === undefined ? signZernioBody(raw, SECRET) : opts.signature
  const res = await POST(
    new Request('https://app.test/api/zernio/webhook/tok', {
      method: 'POST',
      headers: signature ? { 'x-zernio-signature': signature } : {},
      body: raw,
    }),
    { params: Promise.resolve({ token: 'tok' }) },
  )
  for (const cb of h.afterCallbacks.splice(0)) await cb()
  return { status: res.status, json: await res.json() }
}

const MESSAGE = {
  id: 'evt-1',
  event: 'message.received',
  message: { id: 'm1', text: 'Hola', sender: { phoneNumber: '+573112580000' } },
  conversation: { id: 'c1' },
  account: { accountId: 'zacc' },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.afterCallbacks.length = 0
  h.loadConfig.mockResolvedValue(CONFIG)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('POST /api/zernio/webhook/[token]', () => {
  it('404s an unknown token and a disabled config', async () => {
    h.loadConfig.mockResolvedValueOnce(null)
    expect((await call(MESSAGE)).status).toBe(404)
    h.loadConfig.mockResolvedValueOnce({ ...CONFIG, isActive: false })
    expect((await call(MESSAGE)).status).toBe(404)
  })

  it('401s a bad or missing signature and processes nothing', async () => {
    expect((await call(MESSAGE, { signature: 'f'.repeat(64) })).status).toBe(401)
    expect((await call(MESSAGE, { signature: null })).status).toBe(401)
    expect(h.processInbound).not.toHaveBeenCalled()
  })

  it('acks and processes an inbound message in the background', async () => {
    const out = await call(MESSAGE)
    expect(out).toEqual({ status: 200, json: { status: 'received' } })
    expect(h.processInbound).toHaveBeenCalledTimes(1)
    expect(h.processInbound.mock.calls[0][2]).toMatchObject({ messageId: 'm1', text: 'Hola' })
  })

  it('routes delivery statuses to the status handler', async () => {
    await call({ id: 'e', event: 'message.read', message: { id: 'm1' } })
    expect(h.processStatus).toHaveBeenCalledTimes(1)
    expect(h.processInbound).not.toHaveBeenCalled()
  })

  it('acknowledges a Zernio test event without processing it', async () => {
    const out = await call({ ...MESSAGE, test: true })
    expect(out).toEqual({ status: 200, json: { status: 'test' } })
    expect(h.processInbound).not.toHaveBeenCalled()
  })

  it('acks events it does not act on, and says so in the log', async () => {
    const out = await call({ id: 'e', event: 'reaction.received', message: {} })
    expect(out.json).toEqual({ status: 'ignored' })
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('ignored reaction.received'))
    expect(h.processInbound).not.toHaveBeenCalled()
  })

  it('logs every call by event name, never the message text', async () => {
    await call(MESSAGE)
    const lines = vi.mocked(console.info).mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('received message.received'))).toBe(true)
    expect(lines.join('\n')).not.toContain('Hola')
    expect(lines.join('\n')).not.toContain('573112580000')
  })

  it('400s a signed body that is not JSON', async () => {
    const raw = 'not json'
    expect((await call(null, { raw })).status).toBe(400)
  })
})
