import { describe, it, expect } from 'vitest'
import { summarizeConversion } from './conversion'

const at = (day: string) => new Date(`${day}T12:00:00`).toISOString()
const stamp = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00`).toISOString()

describe('AI effectiveness', () => {
  it('rates the AI over the chats it interviewed', () => {
    const s = summarizeConversion(
      '2026-10-16',
      '2026-10-16',
      [],
      [
        { conversation_id: 'c1', source: 'ai', created_at: at('2026-10-16') },
        { conversation_id: 'c2', source: 'manual', created_at: at('2026-10-16') },
      ],
      { aiConversationIds: ['c1', 'c3', 'c4', 'c5'], firstHumanMessageAt: {}, names: {} },
    )
    expect(s.ai).toEqual({ interviewed: 4, registered: 1, rate: 0.25 })
  })

  it('never exceeds 100% when the AI registered a chat with no message of its own in the range', () => {
    const s = summarizeConversion('2026-10-16', '2026-10-16', [], [
      { conversation_id: 'c1', source: 'ai', created_at: at('2026-10-16') },
    ])
    expect(s.ai).toEqual({ interviewed: 1, registered: 1, rate: 1 })
  })

  it('is zero with nothing to measure', () => {
    expect(summarizeConversion('2026-10-16', '2026-10-16', [], []).ai).toEqual({
      interviewed: 0,
      registered: 0,
      rate: 0,
    })
  })
})

describe('per-agent registration time', () => {
  it('averages from the first message of the agent to delivery', () => {
    const s = summarizeConversion(
      '2026-10-16',
      '2026-10-16',
      [],
      [
        {
          conversation_id: 'c1', source: 'manual', created_by_user_id: 'u1',
          created_at: stamp('2026-10-16', '10:50'), delivered_at: stamp('2026-10-16', '11:00'),
        },
        {
          conversation_id: 'c2', source: 'manual', created_by_user_id: 'u1',
          created_at: stamp('2026-10-16', '12:00'), delivered_at: stamp('2026-10-16', '12:30'),
        },
        {
          conversation_id: 'c3', source: 'manual', created_by_user_id: 'u2',
          created_at: stamp('2026-10-16', '09:00'), delivered_at: stamp('2026-10-16', '09:05'),
        },
      ],
      {
        aiConversationIds: [],
        // c1: the agent wrote at 10:00 -> 60 min. c2: no message -> from the form, 30 min.
        firstHumanMessageAt: { c1: stamp('2026-10-16', '10:00') },
        names: { u1: 'Elcy', u2: 'Carolina' },
      },
    )
    expect(s.agents).toEqual([
      { userId: 'u1', name: 'Elcy', registered: 2, received: 0, receivedRegistered: 0, rate: 0, avgMinutes: 45 },
      { userId: 'u2', name: 'Carolina', registered: 1, received: 0, receivedRegistered: 0, rate: 0, avgMinutes: 5 },
    ])
  })

  it('ignores a message that came after the form was opened', () => {
    const s = summarizeConversion(
      '2026-10-16',
      '2026-10-16',
      [],
      [
        {
          conversation_id: 'c1', source: 'manual', created_by_user_id: 'u1',
          created_at: stamp('2026-10-16', '10:00'), delivered_at: stamp('2026-10-16', '10:10'),
        },
      ],
      { aiConversationIds: [], firstHumanMessageAt: { c1: stamp('2026-10-16', '10:05') }, names: { u1: 'Elcy' } },
    )
    expect(s.agents[0].avgMinutes).toBe(10)
  })

  it('falls back to the creation time while the lead is not delivered yet', () => {
    const s = summarizeConversion('2026-10-16', '2026-10-16', [], [
      { conversation_id: 'c1', source: 'manual', created_by_user_id: 'u1', created_at: stamp('2026-10-16', '10:00') },
    ])
    expect(s.agents[0]).toMatchObject({ registered: 1, avgMinutes: 0 })
  })

  it('leaves AI leads out of the table', () => {
    const s = summarizeConversion('2026-10-16', '2026-10-16', [], [
      { conversation_id: 'c1', source: 'ai', created_at: at('2026-10-16') },
    ])
    expect(s.agents).toEqual([])
  })
})
