import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeUsage } from './providers/shared'
import { generateOpenAi, generateOpenAiJson } from './providers/openai'
import { logAiUsage } from './usage'

describe('normalizeUsage — gateway credits', () => {
  it('keeps a reported cost next to the token counts', () => {
    expect(normalizeUsage({ prompt: 100, completion: 20, total: 120, credits: 0.0143 })).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      routerCredits: 0.0143,
    })
  })

  it('omits the field when the provider reports none (plain OpenAI)', () => {
    const out = normalizeUsage({ prompt: 5, completion: 1, total: 6 })
    expect(out).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 })
    expect(out).not.toHaveProperty('routerCredits')
  })

  it('ignores junk cost values and keeps a legitimate zero', () => {
    expect(normalizeUsage({ prompt: 1, completion: 1, credits: -3 })).not.toHaveProperty('routerCredits')
    expect(normalizeUsage({ prompt: 1, completion: 1, credits: 'x' })).not.toHaveProperty('routerCredits')
    expect(normalizeUsage({ prompt: 1, completion: 1, credits: Number.NaN })).not.toHaveProperty('routerCredits')
    expect(normalizeUsage({ prompt: 1, completion: 1, credits: 0 })).toHaveProperty('routerCredits', 0)
  })
})

describe('OpenAI-compatible adapters report credits_charged', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('AI_OPENAI_BASE_URL', '')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const ok = (usage: Record<string, number>) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hola' } }], usage }),
    }) as unknown as Response

  const args = {
    apiKey: 'k',
    model: 'm',
    systemPrompt: 's',
    messages: [{ role: 'user' as const, content: 'hi' }],
    timeoutMs: 1000,
  }

  it('chat completions', async () => {
    fetchMock.mockResolvedValue(
      ok({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, credits_charged: 0.0007 }),
    )
    const out = await generateOpenAi(args)
    expect(out.usage?.routerCredits).toBe(0.0007)
  })

  it('structured output', async () => {
    fetchMock.mockResolvedValue(
      ok({ prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, credits_charged: 0.0241 }),
    )
    const out = await generateOpenAiJson({ ...args, schemaName: 'x', schema: { type: 'object' } })
    expect(out.usage?.routerCredits).toBe(0.0241)
  })

  it('a gateway that reports nothing leaves it undefined', async () => {
    fetchMock.mockResolvedValue(ok({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }))
    const out = await generateOpenAi(args)
    expect(out.usage?.routerCredits).toBeUndefined()
  })
})

describe('logAiUsage — router_credits column', () => {
  const fakeDb = () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    return { db: { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient, insert }
  }
  const base = {
    accountId: 'a',
    conversationId: 'c',
    mode: 'auto_reply' as const,
    provider: 'openai' as const,
    model: 'm',
  }

  it('stores the reported cost', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      ...base,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, routerCredits: 0.5 },
    })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ router_credits: 0.5 }))
  })

  it('stores NULL when the provider did not report one', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, { ...base, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ router_credits: null }))
  })
})
