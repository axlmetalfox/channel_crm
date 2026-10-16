import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ZernioConfig } from './config'
import type { ZernioInbound } from './events'

const h = vi.hoisted(() => ({
  sendZernioText: vi.fn(),
  findExistingContact: vi.fn(),
  dispatchFlows: vi.fn(),
  runAutomations: vi.fn(),
  dispatchAi: vi.fn(),
  dispatchNonText: vi.fn(),
  dispatchWebhook: vi.fn(),
  state: {
    conversation: null as Record<string, unknown> | null,
    existingConversation: true,
    inserted: true,
    priorCustomerMessages: 0,
    statusRow: null as { id: string; status: string } | null,
    ops: [] as { table: string; op: string; values?: Record<string, unknown> }[],
  },
}))

vi.mock('./client', () => ({ sendZernioText: h.sendZernioText }))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: h.findExistingContact,
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchFlows }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: h.runAutomations }))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchAi,
  dispatchNonTextAutoReply: h.dispatchNonText,
}))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatchWebhook }))

import { sendTextViaZernio } from './send'
import { processZernioInbound, processZernioStatus } from './inbound'

const CONFIG: ZernioConfig = {
  id: 'z1',
  accountId: 'acct-1',
  userId: 'user-1',
  apiKey: 'sk_x',
  zernioAccountId: 'zacc',
  webhookToken: 'tok',
  webhookSecret: 'sec',
  isActive: true,
}

/** Chainable stand-in keyed by table; records writes in h.state.ops. */
function fakeDb() {
  return {
    rpc: (name: string) => {
      h.state.ops.push({ table: 'rpc', op: name })
      return Promise.resolve({ error: null })
    },
    from(table: string) {
      let op = 'select'
      let values: Record<string, unknown> | undefined
      let head = false
      const resolve = () => {
        h.state.ops.push({ table, op, values })
        if (op === 'upsert') {
          return { data: h.state.inserted ? [{ id: 'm-db' }] : [], error: null }
        }
        if (op === 'insert') {
          if (table === 'contacts') return { data: { id: 'ct-1', name: null }, error: null }
          if (table === 'conversations') return { data: { id: 'cv-1' }, error: null }
          return { data: null, error: null }
        }
        if (op === 'select') {
          if (table === 'messages' && head) {
            return { data: null, count: h.state.priorCustomerMessages, error: null }
          }
          if (table === 'messages') {
            return { data: h.state.statusRow ? [h.state.statusRow] : [], error: null }
          }
          if (table === 'conversations') {
            return h.state.existingConversation
              ? { data: [h.state.conversation], error: null }
              : { data: [], error: null }
          }
        }
        return { data: null, error: null }
      }
      const b: Record<string, unknown> = {}
      for (const m of ['eq', 'in', 'order', 'limit']) b[m] = () => b
      b.select = (_cols?: string, opts?: { head?: boolean }) => {
        head = !!opts?.head
        return b
      }
      b.insert = (v: Record<string, unknown>) => ((op = 'insert'), (values = v), b)
      b.upsert = (v: Record<string, unknown>) => ((op = 'upsert'), (values = v), b)
      b.update = (v: Record<string, unknown>) => ((op = 'update'), (values = v), b)
      b.single = () => Promise.resolve(resolve())
      b.maybeSingle = () =>
        Promise.resolve(
          table === 'conversations' && op === 'select'
            ? { data: h.state.conversation, error: null }
            : resolve(),
        )
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(ok, bad)
      return b
    },
  } as never
}

const written = (table: string, op: string) =>
  h.state.ops.filter((o) => o.table === table && o.op === op)

beforeEach(() => {
  vi.clearAllMocks()
  h.state.conversation = { id: 'cv-1', zernio_conversation_id: 'zconv-1', status: 'open' }
  h.state.existingConversation = true
  h.state.inserted = true
  h.state.priorCustomerMessages = 0
  h.state.statusRow = null
  h.state.ops = []
  h.sendZernioText.mockResolvedValue({ messageId: 'zmsg-1' })
  h.findExistingContact.mockResolvedValue({ id: 'ct-1', phone: '573112580000', name: 'Ana' })
  h.dispatchFlows.mockResolvedValue({ consumed: false })
  h.runAutomations.mockResolvedValue(undefined)
  h.dispatchAi.mockResolvedValue(undefined)
  h.dispatchWebhook.mockResolvedValue(undefined)
})

describe('sendTextViaZernio', () => {
  it('addresses the Zernio conversation and persists the message', async () => {
    const out = await sendTextViaZernio({
      db: fakeDb(),
      config: CONFIG,
      conversationId: 'cv-1',
      text: 'Hola',
      aiGenerated: true,
    })
    expect(out).toEqual({ whatsapp_message_id: 'zmsg-1' })
    expect(h.sendZernioText).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'zacc', conversationId: 'zconv-1', text: 'Hola' }),
    )
    expect(written('messages', 'insert')[0].values).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      message_id: 'zmsg-1',
      ai_generated: true,
      status: 'sent',
    })
  })

  it('refuses a thread Zernio has never written to', async () => {
    h.state.conversation = { id: 'cv-1', zernio_conversation_id: null }
    await expect(
      sendTextViaZernio({ db: fakeDb(), config: CONFIG, conversationId: 'cv-1', text: 'x' }),
    ).rejects.toThrow(/no Zernio thread/)
    expect(h.sendZernioText).not.toHaveBeenCalled()
  })
})

const INBOUND: ZernioInbound = {
  kind: 'message',
  eventId: 'evt-1',
  messageId: 'zmsg-in',
  conversationId: 'zconv-1',
  accountId: 'zacc',
  phone: '+57 311 258 0000',
  username: null,
  name: 'Ana',
  text: 'Hola',
  contentType: 'text',
  mediaUrl: null,
  sentAt: '2026-10-13T20:00:00Z',
}

describe('processZernioInbound', () => {
  it('stores the message and hands it to flows, automations, the AI and webhooks', async () => {
    await processZernioInbound(fakeDb(), CONFIG, INBOUND)

    expect(written('messages', 'upsert')[0].values).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'customer',
      message_id: 'zmsg-in',
      content_text: 'Hola',
    })
    expect(h.dispatchFlows).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', conversationId: 'cv-1', isFirstInboundMessage: true }),
    )
    expect(h.dispatchAi).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', conversationId: 'cv-1', configOwnerUserId: 'user-1' }),
    )
    expect(h.dispatchWebhook).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'message.received',
      expect.objectContaining({ whatsapp_message_id: 'zmsg-in' }),
    )
  })

  it('accepts a customer whose number WhatsApp hides, creating a contact with no phone', async () => {
    h.state.existingConversation = false
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      phone: null,
      username: 'ana.g',
      name: null,
    })
    const contactInsert = written('contacts', 'insert')[0]
    expect(contactInsert.values).toMatchObject({ phone: '', name: '@ana.g' })
    expect(h.findExistingContact).not.toHaveBeenCalled()
    expect(h.dispatchAi).toHaveBeenCalled()
  })

  it('remembers the Zernio conversation id when it changed', async () => {
    h.state.conversation = { id: 'cv-1', zernio_conversation_id: 'old', status: 'open' }
    await processZernioInbound(fakeDb(), CONFIG, INBOUND)
    expect(
      written('conversations', 'update').some((o) => o.values?.zernio_conversation_id === 'zconv-1'),
    ).toBe(true)
  })

  it('does nothing further for a replayed delivery', async () => {
    h.state.inserted = false
    await processZernioInbound(fakeDb(), CONFIG, INBOUND)
    expect(h.dispatchFlows).not.toHaveBeenCalled()
    expect(h.dispatchAi).not.toHaveBeenCalled()
    expect(h.dispatchWebhook).not.toHaveBeenCalled()
  })

  it('skips the AI when a flow consumed the message', async () => {
    h.dispatchFlows.mockResolvedValue({ consumed: true })
    await processZernioInbound(fakeDb(), CONFIG, INBOUND)
    expect(h.dispatchAi).not.toHaveBeenCalled()
  })

  it('does not call the AI for a message without text', async () => {
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      text: null,
      contentType: 'image',
      mediaUrl: 'https://x/y.png',
    })
    expect(h.dispatchAi).not.toHaveBeenCalled()
    // …but it is not left unanswered: the fixed non-text reply handles it.
    expect(h.dispatchNonText).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', conversationId: 'cv-1' }),
    )
  })

  it('answers the share-button text even with its blanks unfilled (it comes from ads)', async () => {
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      text: '¡Hola! mi nombre es ___ y busco información sobre ___',
    })
    expect(h.dispatchAi).toHaveBeenCalled()
    expect(written('conversations', 'update').some((o) => o.values?.status === 'closed')).toBe(false)
  })

  it('keeps the non-text reply for messages without text only', async () => {
    await processZernioInbound(fakeDb(), CONFIG, INBOUND)
    expect(h.dispatchNonText).not.toHaveBeenCalled()
  })
})

describe('processZernioStatus', () => {
  const ev = (status: 'delivered' | 'read' | 'failed') => ({
    kind: 'status' as const,
    eventId: 'e',
    messageId: 'zmsg-1',
    platformMessageId: null,
    status,
    error: null,
  })

  it('moves a message forward', async () => {
    h.state.statusRow = { id: 'm1', status: 'sent' }
    await processZernioStatus(fakeDb(), CONFIG, ev('delivered'))
    expect(written('messages', 'update')[0].values).toEqual({ status: 'delivered' })
  })

  it('never moves a message backwards', async () => {
    h.state.statusRow = { id: 'm1', status: 'read' }
    await processZernioStatus(fakeDb(), CONFIG, ev('delivered'))
    expect(written('messages', 'update')).toHaveLength(0)
  })

  it('ignores a failure after delivery, but records one while still sent', async () => {
    h.state.statusRow = { id: 'm1', status: 'delivered' }
    await processZernioStatus(fakeDb(), CONFIG, ev('failed'))
    expect(written('messages', 'update')).toHaveLength(0)

    h.state.statusRow = { id: 'm1', status: 'sent' }
    await processZernioStatus(fakeDb(), CONFIG, ev('failed'))
    expect(written('messages', 'update')[0].values).toEqual({ status: 'failed' })
  })

  it('ignores an unknown message', async () => {
    await processZernioStatus(fakeDb(), CONFIG, ev('read'))
    expect(written('messages', 'update')).toHaveLength(0)
  })
})
