import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  captureLead: vi.fn(),
  hasNewer: vi.fn(),
  hasBotText: vi.fn(),
  previousLead: vi.fn(),
  setTag: vi.fn(),
  repliesSince: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    lastBot: null as { created_at: string; content_text: string | null } | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/leads/capture', () => ({ captureLead: h.captureLead }))
vi.mock('@/lib/leads/lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/leads/lookup')>()),
  previousLeadDetails: h.previousLead,
}))
vi.mock('./tags', () => ({ setOfficeHoursTag: h.setTag }))
vi.mock('./guards', () => ({
  hasNewerCustomerText: h.hasNewer,
  hasBotMessageWithText: h.hasBotText,
  aiRepliesSince: h.repliesSince,
  sleep: () => Promise.resolve(),
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        // .select().eq().eq().order().limit().maybeSingle() → last bot message
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.lastBot, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply, dispatchNonTextAutoReply } from './auto-reply'
import { fallbackText } from './fallback'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    handoffEnabled: true,
    leadCaptureEnabled: false,
    nonTextReply: null,
    replyLimitReply: null,
    autoReplySchedule: null,
    consentNotice: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.lastBot = null
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.hasNewer.mockResolvedValue(false)
  h.repliesSince.mockResolvedValue(0)
  h.setTag.mockResolvedValue(undefined)
  h.hasBotText.mockResolvedValue(false)
  h.previousLead.mockResolvedValue(null)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not call the model once the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    // The customer was already told about the limit moments ago.
    h.state.lastBot = {
      created_at: new Date().toISOString(),
      content_text: fallbackText('replyLimit', null),
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

describe('dispatchInboundToAiReply — handoff disabled', () => {
  beforeEach(() => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffEnabled: false }))
  })

  it('tells the prompt builder handoff is off and sends a normal reply', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Esa información te la suministrará nuestro asesor.',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('reply with exactly [[HANDOFF]]')
    expect(systemPrompt).toContain('never handed to a human')
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Esa información te la suministrará nuestro asesor.',
      }),
    )
    expect(h.state.updatePayload).toBeNull()
  })

  it('does not pause or reassign the thread when the model emits the handoff phrase anyway', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    // No ai_autoreply_disabled / assignment / summary written, no slot spent.
    expect(h.state.updatePayload).toBeNull()
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('still sends the text when the phrase trails a real reply', async () => {
    h.generateReply.mockResolvedValue({ text: 'Claro, te ayudo', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Claro, te ayudo' }),
    )
    expect(h.state.updatePayload).toBeNull()
  })
})

describe('dispatchInboundToAiReply — lead capture', () => {
  const CLOSING = 'Tu solicitud ha quedado registrada. [[LEAD_COMPLETE]]'

  it('strips the marker and hands the finished interview to the lead pipeline', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadCaptureEnabled: true }))
    h.generateReply.mockResolvedValue({ text: CLOSING, handoff: false })
    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Tu solicitud ha quedado registrada.' }),
    )
    expect(h.captureLead).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        triggerMessageId: 'm1',
      }),
    )
  })

  it('teaches the model the marker only when lead capture is on', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadCaptureEnabled: true }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply.mock.calls[0][0].systemPrompt).toContain('[[LEAD_COMPLETE]]')

    h.generateReply.mockClear()
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadCaptureEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply.mock.calls[0][0].systemPrompt).not.toContain(
      '[[LEAD_COMPLETE]]',
    )
  })

  it('never leaks the marker to the customer, even with lead capture off', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadCaptureEnabled: false }))
    h.generateReply.mockResolvedValue({ text: CLOSING, handoff: false })
    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Tu solicitud ha quedado registrada.' }),
    )
    expect(h.captureLead).not.toHaveBeenCalled()
  })

  it('does not capture a lead for an ordinary reply', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadCaptureEnabled: true }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.captureLead).not.toHaveBeenCalled()
  })

  it('does not capture when the closing message never went out', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadCaptureEnabled: true }))
    h.generateReply.mockResolvedValue({ text: CLOSING, handoff: false })
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.captureLead).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — reply cap', () => {
  const atCap = () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 3 }
  }
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

  it('tells the customer once, instead of going silent, when the cap is hit recently', async () => {
    atCap()
    h.state.lastBot = { created_at: hoursAgo(0.2), content_text: 'una pregunta' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: fallbackText('replyLimit', null), conversationId: 'conv-1' }),
    )
  })

  it('does not repeat the limit message to a customer who keeps writing', async () => {
    atCap()
    h.state.lastBot = { created_at: hoursAgo(0.2), content_text: fallbackText('replyLimit', null) }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('uses the account’s own limit message when it set one', async () => {
    atCap()
    h.state.lastBot = { created_at: hoursAgo(0.2), content_text: 'x' }
    h.loadAiConfig.mockResolvedValue(aiConfig({ replyLimitReply: 'Vuelve más tarde.' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Vuelve más tarde.' }))
  })

  it('gives the budget back after a quiet spell and answers normally', async () => {
    atCap()
    h.state.lastBot = { created_at: hoursAgo(7), content_text: 'una pregunta' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ ai_reply_count: 0 })
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello!' }))
  })
})

describe('dispatchNonTextAutoReply', () => {
  it('asks for text instead of staying silent', async () => {
    await dispatchNonTextAutoReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: fallbackText('nonText', null), conversationId: 'conv-1', aiGenerated: true }),
    )
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toEqual([]) // no reply slot used
  })

  it('does not answer a second non-text message in a row', async () => {
    h.state.lastBot = { created_at: new Date().toISOString(), content_text: fallbackText('nonText', null) }
    await dispatchNonTextAutoReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('uses the account’s own text', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ nonTextReply: 'Escríbeme, por favor.' }))
    await dispatchNonTextAutoReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Escríbeme, por favor.' }))
  })

  it('stays out when auto-reply is off, a person owns the thread, or the bot was paused', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchNonTextAutoReply(ARGS)
    h.loadAiConfig.mockResolvedValue(aiConfig())
    h.state.conv = { assigned_agent_id: 'agent-1', ai_autoreply_disabled: false, ai_reply_count: 0 }
    await dispatchNonTextAutoReply(ARGS)
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: true, ai_reply_count: 0 }
    await dispatchNonTextAutoReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stands down when a message automation already answers', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchNonTextAutoReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — schedule, bursts and the daily limit', () => {
  const SCHEDULE = {
    timezone: 'America/Bogota',
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }],
  }
  const NEVER = {
    timezone: 'America/Bogota',
    // Only Sundays between 03:00 and 03:01 local time: effectively never.
    windows: [{ days: [0], start: '03:00', end: '03:01' }],
  }

  it('answers inside the schedule', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplySchedule: SCHEDULE }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('stays silent outside the schedule (the message waits for a person)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T17:00:00Z')) // a Wednesday noon in Bogotá
    try {
      h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplySchedule: NEVER }))
      await dispatchInboundToAiReply(ARGS)
      await dispatchNonTextAutoReply(ARGS)
      expect(h.generateReply).not.toHaveBeenCalled()
      expect(h.engineSendText).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tags a contact who writes off duty, and untags them once the agent answers', async () => {
    const tagged = { ...NEVER, officeHoursTag: 'Horario_laboral' }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T17:00:00Z'))
    try {
      h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplySchedule: tagged }))
      await dispatchInboundToAiReply(ARGS)
      expect(h.setTag).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ contactId: 'contact-1', tagName: 'Horario_laboral', on: true }),
      )
      expect(h.engineSendText).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }

    h.loadAiConfig.mockResolvedValue(
      aiConfig({ autoReplySchedule: { ...SCHEDULE, officeHoursTag: 'Horario_laboral' } }),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.setTag).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ tagName: 'Horario_laboral', on: false }),
    )
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not touch tags when the schedule names none', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplySchedule: SCHEDULE }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.setTag).not.toHaveBeenCalled()
  })

  it('steps aside when the customer wrote again during the wait', async () => {
    h.hasNewer.mockResolvedValue(true)
    await dispatchInboundToAiReply({ ...ARGS, inboundMessageId: 'msg-1' })
    expect(h.hasNewer).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'msg-1')
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('answers the last line of a burst', async () => {
    h.hasNewer.mockResolvedValue(false)
    await dispatchInboundToAiReply({ ...ARGS, inboundMessageId: 'msg-2' })
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not wait when the dispatch carries no message id', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.hasNewer).not.toHaveBeenCalled()
  })

  it('stops at the daily limit and tells the customer once', async () => {
    h.repliesSince.mockResolvedValue(40)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: fallbackText('replyLimit', null) }),
    )

    h.engineSendText.mockClear()
    h.state.lastBot = { created_at: new Date().toISOString(), content_text: fallbackText('replyLimit', null) }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('data-processing notice first, and what the chat already told us', () => {
  const NOTICE = 'Al continuar, confirmas que conoces y aceptas la Política de Tratamiento de Datos Personales de INTERTEC SAS.'

  it('sends the notice as the first message, then the agent\'s reply', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ consentNotice: NOTICE }))
    await dispatchInboundToAiReply(ARGS)
    const texts = h.engineSendText.mock.calls.map((c) => c[0].text)
    expect(texts).toEqual([NOTICE, 'Hello!'])
    // The model still sees the customer's message last: the notice was not added to its context.
    expect(h.generateReply.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('does not repeat the notice once the conversation has had it', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ consentNotice: NOTICE }))
    h.hasBotText.mockResolvedValue(true)
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual(['Hello!'])
  })

  it('sends no notice when the account has none', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.hasBotText).not.toHaveBeenCalled()
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual(['Hello!'])
  })

  it('still replies when the notice cannot be sent', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ consentNotice: NOTICE }))
    h.engineSendText.mockRejectedValueOnce(new Error('send failed'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual([NOTICE, 'Hello!'])
  })

  it('sends the notice before the "text only" reply too', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ consentNotice: NOTICE }))
    await dispatchNonTextAutoReply(ARGS)
    const texts = h.engineSendText.mock.calls.map((c) => c[0].text)
    expect(texts[0]).toBe(NOTICE)
    expect(texts[1]).toBe(fallbackText('nonText', null))
  })

  it('tells the model which details this customer already gave, so it does not ask again', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadCaptureEnabled: true }))
    h.previousLead.mockResolvedValue({
      first_name: 'Ana',
      last_name: 'Gómez',
      email: 'ana@x.co',
      company: 'Lácteos',
      document_id: '900123456',
      whatsapp_number: '+573112580000',
      country: 'Colombia',
      city: 'Cali',
    })
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('ALREADY REGISTERED FROM THIS CUSTOMER')
    expect(systemPrompt).toContain('Ana Gómez')
    expect(systemPrompt).toContain('900123456')
    expect(systemPrompt).toMatch(/Do not ask for any of them again/)
  })
})
