import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openAiBaseUrl, OPENAI_DEFAULT_BASE_URL } from './defaults'
import { generateReply } from './generate'
import { embedTexts } from './embeddings'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    handoffEnabled: true,
    leadCaptureEnabled: false,
    nonTextReply: null,
    replyLimitReply: null,
    autoReplySchedule: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function chatOk(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'hola' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
  } as unknown as Response
}

function embeddingsOk(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0 }] }),
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  vi.stubEnv('AI_OPENAI_BASE_URL', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('openAiBaseUrl', () => {
  it('defaults to OpenAI when the variable is unset or blank', () => {
    expect(openAiBaseUrl()).toBe(OPENAI_DEFAULT_BASE_URL)
    vi.stubEnv('AI_OPENAI_BASE_URL', '   ')
    expect(openAiBaseUrl()).toBe(OPENAI_DEFAULT_BASE_URL)
  })

  it('returns a gateway root and trims trailing slashes', () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'https://router.hostinger.com/v1')
    expect(openAiBaseUrl()).toBe('https://router.hostinger.com/v1')
    vi.stubEnv('AI_OPENAI_BASE_URL', ' https://router.hostinger.com/v1/// ')
    expect(openAiBaseUrl()).toBe('https://router.hostinger.com/v1')
  })

  it('keeps a bare origin without a trailing slash', () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'https://gateway.example.com/')
    expect(openAiBaseUrl()).toBe('https://gateway.example.com')
  })

  it('allows plain http only for localhost', () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'http://localhost:4000/v1')
    expect(openAiBaseUrl()).toBe('http://localhost:4000/v1')
    vi.stubEnv('AI_OPENAI_BASE_URL', 'http://gateway.example.com/v1')
    expect(() => openAiBaseUrl()).toThrow(AiError)
  })

  it.each([
    ['not a url'],
    ['ftp://gateway.example.com/v1'],
    ['https://user:pass@gateway.example.com/v1'],
    ['https://gateway.example.com/v1?key=1'],
    ['https://gateway.example.com/v1#frag'],
  ])('fails closed on %s', (value) => {
    vi.stubEnv('AI_OPENAI_BASE_URL', value)
    expect(() => openAiBaseUrl()).toThrow(
      expect.objectContaining({ code: 'misconfigured', status: 500 }),
    )
  })

  it('is read on every call, not frozen at import time', () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'https://one.example.com/v1')
    expect(openAiBaseUrl()).toBe('https://one.example.com/v1')
    vi.stubEnv('AI_OPENAI_BASE_URL', 'https://two.example.com/v1')
    expect(openAiBaseUrl()).toBe('https://two.example.com/v1')
  })
})

describe('openai provider honours AI_OPENAI_BASE_URL', () => {
  it('sends chat completions to the configured gateway with the account key', async () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'https://router.hostinger.com/v1')
    const fetchMock = vi.fn().mockResolvedValue(chatOk())
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ model: 'gpt-5.6-luna', apiKey: 'sk-hstgr-test' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res.text).toBe('hola')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://router.hostinger.com/v1/chat/completions')
    expect(opts.headers.Authorization).toBe('Bearer sk-hstgr-test')
    expect(JSON.parse(opts.body).model).toBe('gpt-5.6-luna')
  })

  it('still targets OpenAI when the variable is unset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatOk())
    vi.stubGlobal('fetch', fetchMock)
    await generateReply({
      config: config(),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
  })

  it('does not call the network when the URL is misconfigured', async () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'http://evil.example.com/v1')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'misconfigured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not affect the anthropic provider', async () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'https://router.hostinger.com/v1')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-test' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })
    expect(fetchMock.mock.calls[0][0]).toContain('api.anthropic.com')
  })
})

describe('embeddings honour AI_OPENAI_BASE_URL', () => {
  it('sends embeddings to the configured gateway', async () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'https://router.hostinger.com/v1')
    const fetchMock = vi.fn().mockResolvedValue(embeddingsOk())
    vi.stubGlobal('fetch', fetchMock)
    await embedTexts('sk-hstgr-test', ['a'])
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://router.hostinger.com/v1/embeddings',
    )
  })

  it('does not call the network when the URL is misconfigured', async () => {
    vi.stubEnv('AI_OPENAI_BASE_URL', 'not a url')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(embedTexts('sk-x', ['a'])).rejects.toBeInstanceOf(AiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
