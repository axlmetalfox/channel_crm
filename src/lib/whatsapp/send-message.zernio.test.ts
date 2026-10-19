import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  loadZernioConfig: vi.fn(),
  sendTextViaZernio: vi.fn(),
  sendMedia: vi.fn(),
  sendTemplate: vi.fn(),
  pausedFlows: [] as string[],
}))

vi.mock('@/lib/zernio/config', () => ({ loadZernioConfig: h.loadZernioConfig }))
vi.mock('@/lib/zernio/send', () => ({
  sendTextViaZernio: h.sendTextViaZernio,
  sendMediaViaZernio: h.sendMedia,
  sendTemplateViaZernio: h.sendTemplate,
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.update = () => b
      b.eq = (c: string, v: string) => {
        if (c === 'contact_id') h.pausedFlows.push(v)
        return b
      }
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok)
      return b
    },
  }),
}))

import { ZernioError } from '@/lib/zernio/client'
import { sendMessageToConversation, SendMessageError } from './send-message'

const CONVERSATION = { id: 'cv-1', contact: { id: 'ct-1', phone: '' } }
const db = {
  from: () => {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.single = () => Promise.resolve({ data: CONVERSATION, error: null })
    return b
  },
} as never

const PARAMS = { conversationId: 'cv-1', messageType: 'text', contentText: 'Hola, soy Elcy' }

beforeEach(() => {
  vi.clearAllMocks()
  h.pausedFlows = []
  h.loadZernioConfig.mockResolvedValue({ apiKey: 'sk_x', zernioAccountId: 'zacc' })
  h.sendTextViaZernio.mockResolvedValue({ whatsapp_message_id: 'zmsg-9', message_id: 'm-9' })
  h.sendMedia.mockResolvedValue({ whatsapp_message_id: 'zmsg-img', message_id: 'm-img' })
  h.sendTemplate.mockResolvedValue({ whatsapp_message_id: 'zmsg-tpl', message_id: 'm-tpl' })
})

describe('sendMessageToConversation on an account that uses Zernio', () => {
  it('sends text through Zernio as an agent, even when the customer has no visible number', async () => {
    const out = await sendMessageToConversation(db, 'acct-1', PARAMS)
    expect(out).toEqual({ messageId: 'm-9', whatsappMessageId: 'zmsg-9' })
    expect(h.sendTextViaZernio).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cv-1', text: 'Hola, soy Elcy', senderType: 'agent' }),
    )
    // The agent stepping in pauses any running flow for the contact.
    expect(h.pausedFlows).toEqual(['ct-1'])
  })

  it('sends a photo, video, audio file or document through Zernio', async () => {
    for (const kind of ['image', 'video', 'audio', 'document']) {
      h.sendMedia.mockClear()
      const out = await sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: kind,
        mediaUrl: 'https://files.example/chat-media/account-acct-1/x.bin',
        contentText: 'Mira la máquina',
        filename: 'catalogo.pdf',
      })
      expect(out).toEqual({ messageId: 'm-img', whatsappMessageId: 'zmsg-img' })
      expect(h.sendMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          kind,
          mediaUrl: 'https://files.example/chat-media/account-acct-1/x.bin',
          caption: 'Mira la máquina',
          filename: 'catalogo.pdf',
          senderType: 'agent',
        }),
      )
    }
    expect(h.pausedFlows.length).toBeGreaterThan(0)
  })

  it('sends an approved template through Zernio with its values and rendered text', async () => {
    const out = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'retomar_solicitud',
      templateLanguage: 'es',
      templateParams: ['Carlos'],
      contentText: 'Buen día, señor(a) Carlos.',
    })
    expect(out).toEqual({ messageId: 'm-tpl', whatsappMessageId: 'zmsg-tpl' })
    expect(h.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'retomar_solicitud',
        language: 'es',
        bodyParams: ['Carlos'],
        renderedText: 'Buen día, señor(a) Carlos.',
      }),
    )
    expect(h.sendTextViaZernio).not.toHaveBeenCalled()
  })

  it('still refuses buttons (interactive messages), and says so plainly', async () => {
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'interactive',
        interactivePayload: { kind: 'buttons', body: 'x', buttons: [{ id: '1', title: 'a' }] } as never,
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not buttons/i) })
    expect(h.sendTextViaZernio).not.toHaveBeenCalled()
    expect(h.sendTemplate).not.toHaveBeenCalled()
  })

  it('turns a Zernio rejection (for example the 24h window) into a readable 400', async () => {
    h.sendTextViaZernio.mockRejectedValue(new ZernioError('Outside the 24-hour window', 422))
    await expect(sendMessageToConversation(db, 'acct-1', PARAMS)).rejects.toMatchObject({
      status: 400,
      message: 'Outside the 24-hour window',
    })
  })

  it('refuses a thread Zernio has never written to', async () => {
    h.sendTextViaZernio.mockRejectedValue(new Error('This conversation has no Zernio thread yet — the customer has to write first.'))
    const err = await sendMessageToConversation(db, 'acct-1', PARAMS).catch((e) => e)
    expect(err).toBeInstanceOf(SendMessageError)
    expect(err.status).toBe(400)
  })
})
