import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signZernioBody, verifyZernioSignature } from './signature'
import { parseZernioEvent } from './events'
import {
  ZernioError,
  checkZernioAccount,
  registerZernioWebhook,
  sendZernioText,
  zernioBaseUrl,
} from './client'

describe('verifyZernioSignature', () => {
  const body = '{"id":"e1","event":"message.received"}'
  const secret = 'whsec_test'

  it('accepts the HMAC-SHA256 hex of the raw body', () => {
    expect(verifyZernioSignature(body, signZernioBody(body, secret), secret)).toBe(true)
  })

  it('tolerates case, whitespace and a sha256= prefix', () => {
    const sig = signZernioBody(body, secret)
    expect(verifyZernioSignature(body, `  sha256=${sig.toUpperCase()} `, secret)).toBe(true)
  })

  it('rejects a different body, secret, or missing header', () => {
    const sig = signZernioBody(body, secret)
    expect(verifyZernioSignature(body + ' ', sig, secret)).toBe(false)
    expect(verifyZernioSignature(body, sig, 'other')).toBe(false)
    expect(verifyZernioSignature(body, null, secret)).toBe(false)
    expect(verifyZernioSignature(body, 'not-hex', secret)).toBe(false)
  })
})

describe('parseZernioEvent', () => {
  const received = {
    id: 'evt-1',
    event: 'message.received',
    message: {
      id: 'msg-1',
      platformMessageId: 'wamid.X',
      text: 'Hola',
      attachments: [],
      sender: { id: 's1', name: 'Ana', phoneNumber: '+57 311 258 0000' },
      sentAt: '2026-10-13T20:00:00Z',
    },
    conversation: { id: 'conv-9' },
    account: { accountId: 'acc-1', profileId: 'p1' },
  }

  it('reads an inbound text message', () => {
    expect(parseZernioEvent(received)).toMatchObject({
      kind: 'message',
      eventId: 'evt-1',
      messageId: 'msg-1',
      conversationId: 'conv-9',
      accountId: 'acc-1',
      phone: '+57 311 258 0000',
      name: 'Ana',
      text: 'Hola',
      contentType: 'text',
      mediaUrl: null,
    })
  })

  it('maps an attachment-only message to its media type', () => {
    const ev = parseZernioEvent({
      ...received,
      message: {
        ...received.message,
        text: null,
        attachments: [{ type: 'image', url: 'https://x/y.png' }],
      },
    })
    expect(ev).toMatchObject({ contentType: 'image', mediaUrl: 'https://x/y.png' })
  })

  it('ignores an inbound message with no phone or conversation', () => {
    expect(
      parseZernioEvent({ ...received, message: { ...received.message, sender: { name: 'x' } } }),
    ).toBeNull()
    expect(parseZernioEvent({ ...received, conversation: {} })).toBeNull()
  })

  it('reads delivery statuses and failures', () => {
    expect(
      parseZernioEvent({ id: 'e', event: 'message.read', message: { id: 'm', platformMessageId: 'w' } }),
    ).toMatchObject({ kind: 'status', status: 'read', messageId: 'm', platformMessageId: 'w' })
    expect(
      parseZernioEvent({
        id: 'e',
        event: 'message.failed',
        message: { id: 'm' },
        error: { code: '131026', message: 'Unreachable' },
      }),
    ).toMatchObject({ status: 'failed', error: 'Unreachable' })
  })

  it('ignores events it does not act on and junk', () => {
    expect(parseZernioEvent({ id: 'e', event: 'reaction.received', message: {} })).toBeNull()
    expect(parseZernioEvent(null)).toBeNull()
    expect(parseZernioEvent('x')).toBeNull()
  })
})

describe('Zernio client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.ZERNIO_API_BASE
  })
  afterEach(() => vi.unstubAllGlobals())

  const json = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: async () => body }) as Response

  it('sends text with bearer auth, account id and an idempotency key', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, data: { messageId: 'm-1' } }))
    const out = await sendZernioText({
      apiKey: 'sk_x',
      accountId: 'acc',
      conversationId: 'c/1',
      text: 'Hola',
      idempotencyKey: 'k1',
    })
    expect(out).toEqual({ messageId: 'm-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://zernio.com/api/v1/inbox/conversations/c%2F1/messages')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk_x', 'Idempotency-Key': 'k1' })
    expect(JSON.parse(init.body)).toEqual({ accountId: 'acc', message: 'Hola' })
  })

  it('surfaces API errors with status and code', async () => {
    fetchMock.mockResolvedValue(json(401, { error: 'bad key', code: 'invalid_credentials' }))
    await expect(
      sendZernioText({ apiKey: 'x', accountId: 'a', conversationId: 'c', text: 't' }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials', message: 'bad key' })
  })

  it('fails when Zernio accepts the send but returns no id', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, data: {} }))
    await expect(
      sendZernioText({ apiKey: 'x', accountId: 'a', conversationId: 'c', text: 't' }),
    ).rejects.toBeInstanceOf(ZernioError)
  })

  it('reads account health', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        accountId: 'acc',
        platform: 'whatsapp',
        username: '+57…',
        status: 'healthy',
        platformConnection: { status: 'connected', inboundWebhookSubscribed: true },
      }),
    )
    expect(await checkZernioAccount('k', 'acc')).toMatchObject({
      platform: 'whatsapp',
      connection: 'connected',
      inboundWebhookSubscribed: true,
    })
  })

  it('registers the webhook with the events, account scope and our secret', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { id: 'wh-1' } }))
    const out = await registerZernioWebhook({
      apiKey: 'k',
      name: 'wacrm',
      url: 'https://app/api/zernio/webhook/t',
      secret: 'whsec_s',
      accountId: 'acc',
    })
    expect(out).toEqual({ id: 'wh-1' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ secret: 'whsec_s', accountIds: ['acc'] })
    expect(body.events).toContain('message.received')
  })

  it('refuses a non-https base URL override', () => {
    process.env.ZERNIO_API_BASE = 'http://evil.test/api'
    expect(() => zernioBaseUrl()).toThrow(ZernioError)
  })
})
