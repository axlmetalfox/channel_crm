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

