import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ZernioConfig } from './config'
import type { ZernioInbound } from './events'

const h = vi.hoisted(() => ({
  sendZernioText: vi.fn(),
  sendZernioAttachment: vi.fn(),
  findExistingContact: vi.fn(),
  dispatchFlows: vi.fn(),
  runAutomations: vi.fn(),
  dispatchAi: vi.fn(),
  dispatchNonText: vi.fn(),
  dispatchWebhook: vi.fn(),
  mirror: vi.fn(),
  transcribe: vi.fn(),
  loadAiConfig: vi.fn(),
  logUsage: vi.fn(),
  state: {
    conversation: null as Record<string, unknown> | null,
    existingConversation: true,
    inserted: true,
    priorCustomerMessages: 0,
    priorOutbound: 0,
    statusRow: null as { id: string; status: string } | null,
    ops: [] as { table: string; op: string; values?: Record<string, unknown> }[],
  },
}))

vi.mock('./client', () => ({ sendZernioText: h.sendZernioText, sendZernioAttachment: h.sendZernioAttachment }))
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
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({ mirrorInboundMedia: h.mirror }))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: h.logUsage }))
vi.mock('@/lib/ai/transcribe', () => ({
  AUDIO_MAX_BYTES: 1_000_000,
  transcribeAudio: h.transcribe,
  transcriptionModel: () => process.env.AI_TRANSCRIBE_MODEL?.trim() || null,
}))

import { sendMediaViaZernio, sendTextViaZernio } from './send'
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
      let outbound = false
      const resolve = () => {
        h.state.ops.push({ table, op, values })
        if (op === 'upsert') {
          return { data: h.state.inserted ? [{ id: 'm-db' }] : [], error: null }
        }
        if (op === 'insert') {
          if (table === 'contacts') return { data: { id: 'ct-1', name: null }, error: null }
          if (table === 'conversations') return { data: { id: 'cv-1' }, error: null }
          if (table === 'messages') return { data: { id: 'm-db' }, error: null }
          return { data: null, error: null }
        }
        if (op === 'select') {
          if (table === 'messages' && head) {
            return { data: null, count: outbound ? h.state.priorOutbound : h.state.priorCustomerMessages, error: null }
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
      for (const m of ['eq', 'order', 'limit']) b[m] = () => b
      b.in = (col: string) => {
        if (col === 'sender_type') outbound = true
        return b
      }
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
  h.state.priorOutbound = 0
  h.state.statusRow = null
  h.state.ops = []
  h.sendZernioText.mockResolvedValue({ messageId: 'zmsg-1' })
  h.sendZernioAttachment.mockResolvedValue({ messageId: 'zmsg-att' })
  h.findExistingContact.mockResolvedValue({ id: 'ct-1', phone: '573112580000', name: 'Ana' })
  h.dispatchFlows.mockResolvedValue({ consumed: false })
  h.runAutomations.mockResolvedValue(undefined)
  h.dispatchAi.mockResolvedValue(undefined)
  h.dispatchWebhook.mockResolvedValue(undefined)
  h.mirror.mockResolvedValue(null)
  h.loadAiConfig.mockResolvedValue({ provider: 'openai', apiKey: 'k' })
  h.transcribe.mockResolvedValue({ text: null, usage: null })
  delete process.env.AI_TRANSCRIBE_MODEL
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
    expect(out).toEqual({ whatsapp_message_id: 'zmsg-1', message_id: 'm-db' })
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

describe('sendMediaViaZernio', () => {
  const send = (over: Record<string, unknown>) =>
    sendMediaViaZernio({
      db: fakeDb(),
      config: CONFIG,
      conversationId: 'cv-1',
      kind: 'image',
      mediaUrl: 'https://files.example/chat-media/account-acct-1/foto.jpg',
      ...over,
    } as Parameters<typeof sendMediaViaZernio>[0])

  it('sends a photo with its caption and records it as an agent message with the file', async () => {
    const out = await send({ kind: 'image', caption: 'Así queda el empaque' })
    expect(out).toEqual({ whatsapp_message_id: 'zmsg-att', message_id: 'm-db' })
    expect(h.sendZernioAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'zconv-1',
        attachmentType: 'image',
        attachmentUrl: 'https://files.example/chat-media/account-acct-1/foto.jpg',
        text: 'Así queda el empaque',
        voiceNote: false,
      }),
    )
    expect(written('messages', 'insert')[0].values).toMatchObject({
      sender_type: 'agent',
      content_type: 'image',
      content_text: 'Así queda el empaque',
      media_url: 'https://files.example/chat-media/account-acct-1/foto.jpg',
      message_id: 'zmsg-att',
    })
  })

  it('sends a document as a file with its name, and keeps the name as the shown text', async () => {
    await send({
      kind: 'document',
      mediaUrl: 'https://files.example/chat-media/account-acct-1/cot.pdf',
      filename: 'Cotizacion.pdf',
    })
    expect(h.sendZernioAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentType: 'file', attachmentName: 'Cotizacion.pdf' }),
    )
    expect(written('messages', 'insert')[0].values).toMatchObject({
      content_type: 'document',
      content_text: 'Cotizacion.pdf',
    })
  })

  it('sends a recorded .ogg as a voice note, but an mp3 as a plain audio file, never with a caption', async () => {
    await send({ kind: 'audio', mediaUrl: 'https://files.example/chat-media/account-acct-1/nota.ogg', caption: 'x' })
    expect(h.sendZernioAttachment).toHaveBeenLastCalledWith(
      expect.objectContaining({ attachmentType: 'audio', voiceNote: true, text: null }),
    )
    await send({ kind: 'audio', mediaUrl: 'https://files.example/chat-media/account-acct-1/cancion.mp3' })
    expect(h.sendZernioAttachment).toHaveBeenLastCalledWith(
      expect.objectContaining({ attachmentType: 'audio', voiceNote: false }),
    )
  })

  it('refuses a thread Zernio has never written to', async () => {
    h.state.conversation = { id: 'cv-1', zernio_conversation_id: null }
    await expect(send({})).rejects.toThrow(/no Zernio thread/)
    expect(h.sendZernioAttachment).not.toHaveBeenCalled()
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
  mimeType: null,
  fileName: null,
  sentAt: '2026-10-13T20:00:00Z',
  referral: null,
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

  it('saves the ad a chat came from', async () => {
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      referral: {
        sourceType: 'ad',
        sourceId: '120210000000001',
        sourceUrl: 'https://fb.me/abc',
        headline: 'Más precisión',
        body: 'La ventaja de tu competencia',
        mediaType: 'video',
        ctwaClid: 'AfX123',
      },
    })
    const saved = written('conversations', 'update').find((o) => o.values?.attribution)
    expect(saved?.values?.attribution).toMatchObject({
      source_type: 'ad',
      source_id: '120210000000001',
      source_url: 'https://fb.me/abc',
      headline: 'Más precisión',
      ctwa_clid: 'AfX123',
    })
  })

  it('does not touch attribution for an organic message', async () => {
    await processZernioInbound(fakeDb(), CONFIG, INBOUND)
    expect(written('conversations', 'update').some((o) => o.values && 'attribution' in o.values)).toBe(false)
  })

  it('stays silent when the first thing a person sends is only somebody else\'s shared reel', async () => {
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      text: 'https://www.facebook.com/share/r/1GwhWZ8toN/',
    })
    expect(h.dispatchAi).not.toHaveBeenCalled()
    expect(h.dispatchNonText).not.toHaveBeenCalled()
    // The message itself is still stored for the team to see.
    expect(written('messages', 'upsert')).toHaveLength(1)
  })

  it('still answers a shared link inside a conversation we are already in', async () => {
    h.state.priorOutbound = 2
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      text: 'https://www.facebook.com/share/r/1GwhWZ8toN/',
    })
    expect(h.dispatchAi).toHaveBeenCalled()
  })

  it('still answers a shared link that comes from one of our ads, or has text with it', async () => {
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      text: 'https://www.facebook.com/share/r/1GwhWZ8toN/',
      referral: {
        sourceType: 'ad',
        sourceId: '1',
        sourceUrl: 'https://fb.me/x',
        headline: null,
        body: null,
        mediaType: null,
        ctwaClid: 'c',
      },
    })
    expect(h.dispatchAi).toHaveBeenCalledTimes(1)
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      eventId: 'evt-2',
      messageId: 'zmsg-in-2',
      text: 'Quiero esta máquina https://www.facebook.com/share/r/1GwhWZ8toN/',
    })
    expect(h.dispatchAi).toHaveBeenCalledTimes(2)
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

  it('copies a photo or voice note into our storage so the team can open it', async () => {
    h.mirror.mockResolvedValue('https://files.example/chat-media/account-acct-1/inbound/zmsg-in-image.jpg')
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      text: null,
      contentType: 'image',
      mediaUrl: 'https://zernio.com/api/v1/whatsapp/media/123?accountId=zacc',
      mimeType: 'image/jpeg',
    })
    expect(h.mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        downloadUrl: 'https://zernio.com/api/v1/whatsapp/media/123?accountId=zacc',
        accessToken: 'sk_x',
        mimeType: 'image/jpeg',
      }),
    )
    const updated = written('messages', 'update').find((o) => o.values?.media_url)
    expect(updated?.values?.media_url).toContain('chat-media')
  })

  describe('voice notes', () => {
    const VOICE = {
      ...INBOUND,
      text: null,
      contentType: 'audio' as const,
      mediaUrl: 'https://zernio.com/api/v1/whatsapp/media/9?accountId=zacc',
      mimeType: 'audio/ogg; codecs=opus',
    }
    const bucketUrl = 'https://files.example/chat-media/account-acct-1/inbound/voz.ogg'

    beforeEach(() => {
      process.env.AI_TRANSCRIBE_MODEL = 'gemini-2.5-flash-lite'
      h.mirror.mockResolvedValue(bucketUrl)
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          headers: { get: () => 'audio/ogg' },
        }),
      )
    })
    afterEach(() => vi.unstubAllGlobals())

    it('turns what was said into text, keeps it on the message and answers it like a typed one', async () => {
      h.transcribe.mockResolvedValue({ text: 'Necesito una máquina para queso', usage: null })
      await processZernioInbound(fakeDb(), CONFIG, VOICE)
      expect(h.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-2.5-flash-lite', mimeType: 'audio/ogg; codecs=opus' }),
      )
      expect(written('messages', 'update').some((o) => o.values?.content_text === 'Necesito una máquina para queso')).toBe(true)
      expect(h.dispatchAi).toHaveBeenCalled()
      expect(h.dispatchNonText).not.toHaveBeenCalled()
      expect(h.logUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: 'audio_transcribe' }))
    })

    it('falls back to asking the customer to write when it cannot be made out', async () => {
      h.transcribe.mockResolvedValue({ text: null, usage: null })
      await processZernioInbound(fakeDb(), CONFIG, VOICE)
      expect(h.dispatchAi).not.toHaveBeenCalled()
      expect(h.dispatchNonText).toHaveBeenCalled()
    })

    it('falls back too when the provider fails or the feature is off', async () => {
      h.transcribe.mockRejectedValue(new Error('provider down'))
      await processZernioInbound(fakeDb(), CONFIG, VOICE)
      expect(h.dispatchNonText).toHaveBeenCalledTimes(1)

      delete process.env.AI_TRANSCRIBE_MODEL
      h.transcribe.mockClear()
      await processZernioInbound(fakeDb(), CONFIG, { ...VOICE, eventId: 'e5', messageId: 'zmsg-in-5' })
      expect(h.transcribe).not.toHaveBeenCalled()
      expect(h.dispatchNonText).toHaveBeenCalledTimes(2)
    })

    it('does not transcribe photos or videos', async () => {
      await processZernioInbound(fakeDb(), CONFIG, { ...VOICE, contentType: 'image' as const, mimeType: 'image/jpeg' })
      expect(h.transcribe).not.toHaveBeenCalled()
    })
  })

  it('keeps the original link when the copy fails, and does not copy plain text', async () => {
    await processZernioInbound(fakeDb(), CONFIG, {
      ...INBOUND,
      text: null,
      contentType: 'audio',
      mediaUrl: 'https://zernio.com/api/v1/whatsapp/media/9?accountId=zacc',
    })
    expect(h.mirror).toHaveBeenCalledTimes(1)
    expect(written('messages', 'update').some((o) => o.values?.media_url)).toBe(false)

    h.mirror.mockClear()
    await processZernioInbound(fakeDb(), CONFIG, { ...INBOUND, eventId: 'e3', messageId: 'zmsg-in-3' })
    expect(h.mirror).not.toHaveBeenCalled()
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
