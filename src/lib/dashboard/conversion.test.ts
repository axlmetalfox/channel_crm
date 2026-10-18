import { describe, it, expect } from 'vitest'
import { dayKeysBetween, summarizeConversion } from './conversion'

// Noon local time, so the local day is the same in any time zone.
const at = (day: string) => new Date(`${day}T12:00:00`).toISOString()

describe('dayKeysBetween', () => {
  it('lists every day, both ends included', () => {
    expect(dayKeysBetween('2026-10-16', '2026-10-19')).toEqual([
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
    ])
    expect(dayKeysBetween('2026-10-16', '2026-10-16')).toEqual(['2026-10-16'])
  })
})

describe('summarizeConversion', () => {
  const conversations = [
    { created_at: at('2026-10-16') },
    { created_at: at('2026-10-16') },
    { created_at: at('2026-10-17') },
    { created_at: at('2026-10-17') },
  ]

  it('counts incoming conversations and the registered ones by who did it', () => {
    const s = summarizeConversion('2026-10-16', '2026-10-17', conversations, [
      { conversation_id: 'c1', source: 'ai', created_at: at('2026-10-16') },
      { conversation_id: 'c2', source: 'manual', created_at: at('2026-10-17') },
      { conversation_id: 'c3', source: 'ai', created_at: at('2026-10-17') },
    ])
    expect(s.incoming).toBe(4)
    expect(s.converted).toBe(3)
    expect(s.byAi).toBe(2)
    expect(s.byHuman).toBe(1)
    expect(s.rate).toBeCloseTo(0.75)
    expect(s.days).toEqual([
      { day: '2026-10-16', incoming: 2, byAi: 1, byHuman: 0 },
      { day: '2026-10-17', incoming: 2, byAi: 1, byHuman: 1 },
    ])
  })

  it('counts a conversation once even with several leads, and in the total once when both registered it', () => {
    const s = summarizeConversion('2026-10-16', '2026-10-17', conversations, [
      { conversation_id: 'c1', source: 'ai', created_at: at('2026-10-16') },
      { conversation_id: 'c1', source: 'ai', created_at: at('2026-10-16') },
      { conversation_id: 'c1', source: 'manual', created_at: at('2026-10-17') },
    ])
    expect(s.converted).toBe(1)
    expect(s.byAi).toBe(1)
    expect(s.byHuman).toBe(1)
  })

  it('keeps leads whose conversation was deleted', () => {
    const s = summarizeConversion('2026-10-16', '2026-10-16', [], [
      { conversation_id: null, source: 'ai', created_at: at('2026-10-16') },
      { conversation_id: null, source: 'ai', created_at: at('2026-10-16') },
    ])
    expect(s.converted).toBe(2)
  })

  it('has a zero rate and zeroed days when nothing happened', () => {
    const s = summarizeConversion('2026-10-16', '2026-10-17', [], [])
    expect(s).toMatchObject({ incoming: 0, converted: 0, rate: 0 })
    expect(s.days).toHaveLength(2)
  })
})
