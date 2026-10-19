import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listZernioTemplates,
  sendZernioTemplate,
  startZernioConversation,
} from './client'
import { sendTemplateViaZernio } from './send'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Zernio template client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('lists the templates of the connected account', async () => {
    fetchMock.mockResolvedValue(
      json(200, { success: true, templates: [{ id: '1', name: 'retomar_solicitud', status: 'APPROVED', language: 'es', category: 'UTILITY' }] }),
    )
    const out = await listZernioTemplates({ apiKey: 'k', accountId: 'acc 1' })
    expect(out).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/whatsapp/templates?accountId=acc%201')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer k')
  })

  it('sends a template inside a conversation with the body values in order', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, data: { messageId: 'wamid.1' } }))
    const out = await sendZernioTemplate({
      apiKey: 'k', accountId: 'acc', conversationId: 'c/1', name: 'retomar_solicitud', language: 'es', bodyParams: ['Carlos'],
    })
    expect(out.messageId).toBe('wamid.1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/inbox/conversations/c%2F1/messages')
    expect(JSON.parse(init.body)).toEqual({
      accountId: 'acc',
      template: {
        elements: [
          { name: 'retomar_solicitud', language: 'es', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Carlos' }] }] },
        ],
      },
    })
  })

  it('opens a conversation by phone with digits only and returns the new conversation id', async () => {
    fetchMock.mockResolvedValue(json(201, { success: true, data: { messageId: 'wamid.2', conversationId: 'zc-9' } }))
    const out = await startZernioConversation({
      apiKey: 'k', accountId: 'acc', phone: '+57 302 857 1503', name: 'retomar_solicitud', language: 'es', bodyParams: ['Ana'],
    })
    expect(out).toEqual({ messageId: 'wamid.2', conversationId: 'zc-9' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      accountId: 'acc',
      participantId: '573028571503',
      templateName: 'retomar_solicitud',
      templateLanguage: 'es',
      templateParams: ['Ana'],
    })
  })

  it('fails loudly when Zernio answers without ids', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, data: {} }))
    await expect(
      startZernioConversation({ apiKey: 'k', accountId: 'a', phone: '573000000000', name: 'x', language: 'es', bodyParams: [] }),
    ).rejects.toThrow(/no conversation/)
  })
})

describe('sendTemplateViaZernio', () => {
  const fetchMock = vi.fn()
  const config = { apiKey: 'k', zernioAccountId: 'acc' } as never

  function fakeDb(conv: Record<string, unknown> | null) {
    const state = { inserted: null as Record<string, unknown> | null, updates: [] as Record<string, unknown>[] }
    const db = {
      from(table: string) {
        let mode: 'select' | 'insert' | 'update' = 'select'
        let values: Record<string, unknown> = {}
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.insert = (v: Record<string, unknown>) => ((mode = 'insert'), (values = v), b)
        b.update = (v: Record<string, unknown>) => ((mode = 'update'), (values = v), b)
        b.maybeSingle = () => Promise.resolve({ data: conv, error: null })
        b.single = () => {
          state.inserted = values
          return Promise.resolve({ data: { id: 'row-1' }, error: null })
        }
        b.then = (ok: (v: unknown) => unknown) => {
          if (table === 'conversations' && mode === 'update') state.updates.push(values)
          return Promise.resolve({ error: null }).then(ok)
        }
        return b
      },
    }
    return { db: db as never, state }
  }

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('uses the existing Zernio thread and stores the rendered template', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, data: { messageId: 'wamid.7' } }))
    const { db, state } = fakeDb({ zernio_conversation_id: 'zc-1', contact: { phone: '573028571503' } })
    const out = await sendTemplateViaZernio({
      db, config, conversationId: 'cv-1', templateName: 'retomar_solicitud', language: 'es', bodyParams: ['Carlos'], renderedText: 'Buen día, señor(a) Carlos.',
    })
    expect(out.whatsapp_message_id).toBe('wamid.7')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/inbox/conversations/zc-1/messages')
    expect(state.inserted).toMatchObject({
      sender_type: 'agent', content_type: 'template', template_name: 'retomar_solicitud', content_text: 'Buen día, señor(a) Carlos.', message_id: 'wamid.7',
    })
  })

  it('opens the chat by phone when the customer has no Zernio thread, and remembers the new one', async () => {
    fetchMock.mockResolvedValue(json(201, { success: true, data: { messageId: 'wamid.8', conversationId: 'zc-new' } }))
    const { db, state } = fakeDb({ zernio_conversation_id: null, contact: [{ phone: '573028571503' }] })
    await sendTemplateViaZernio({
      db, config, conversationId: 'cv-2', templateName: 'retomar_solicitud', language: 'es', bodyParams: ['Ana'], renderedText: 'Hola Ana',
    })
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/inbox\/conversations$/)
    expect(state.updates).toContainEqual({ zernio_conversation_id: 'zc-new' })
  })

  it('refuses a customer without a visible phone and without a thread', async () => {
    const { db } = fakeDb({ zernio_conversation_id: null, contact: { phone: '' } })
    await expect(
      sendTemplateViaZernio({ db, config, conversationId: 'cv-3', templateName: 't', language: 'es', bodyParams: [], renderedText: 'x' }),
    ).rejects.toThrow(/no visible phone/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
