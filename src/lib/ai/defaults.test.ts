import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

describe('buildSystemPrompt — handoff', () => {
  it('teaches the handoff phrase in auto-reply mode by default', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(p).toContain(`reply with exactly ${HANDOFF_SENTINEL}`)
  })

  it('uses the handoff fallback for the knowledge base by default', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: ['A fact.'],
    })
    expect(p).toContain(`reply with exactly ${HANDOFF_SENTINEL} so a human can help`)
  })

  it('never mentions replying with the phrase when handoff is disabled', () => {
    const p = buildSystemPrompt({
      userPrompt: 'Say X when you lack information.',
      mode: 'auto_reply',
      knowledge: ['A fact.'],
      handoffEnabled: false,
    })
    expect(p).not.toContain('reply with exactly')
    expect(p).toContain('never output the control phrase')
    expect(p).toContain('follow the business instructions')
    // The business instructions are still included verbatim.
    expect(p).toContain('Say X when you lack information.')
  })

  it('leaves draft mode unaffected by the flag', () => {
    const on = buildSystemPrompt({ userPrompt: 'P', mode: 'draft' })
    const off = buildSystemPrompt({
      userPrompt: 'P',
      mode: 'draft',
      handoffEnabled: false,
    })
    expect(off).toBe(on)
    expect(on).not.toContain(HANDOFF_SENTINEL)
  })
})
