import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  loadZernioConfig: vi.fn(),
  sendTextViaZernio: vi.fn(),
  pausedFlows: [] as string[],
}))

vi.mock('@/lib/zernio/config', () => ({ loadZernioConfig: h.loadZernioConfig }))
vi.mock('@/lib/zernio/send', () => ({ sendTextViaZernio: h.sendTextViaZernio }))
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

  it('says plainly that only text is supported for now', async () => {
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'image',
        mediaUrl: 'https://x/y.png',
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/only text/i) })
    expect(h.sendTextViaZernio).not.toHaveBeenCalled()
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
