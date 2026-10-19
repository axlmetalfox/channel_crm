import { describe, it, expect } from 'vitest'
import { summarizeMine } from './conversion'

const stamp = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00`).toISOString()
const D1 = '2026-10-19'
const D2 = '2026-10-20'

describe('summarizeMine', () => {
  const extras = {
    aiConversationIds: ['c1', 'c2', 'c3'],
    firstHumanMessageAt: {},
    names: { me: 'Elcy', other: 'Carolina' },
    assignments: [
      { conversation_id: 'c1', agent_id: 'me', assigned_at: stamp(D1, '09:00') },
      { conversation_id: 'c2', agent_id: 'me', assigned_at: stamp(D2, '09:00') },
      { conversation_id: 'c3', agent_id: 'other', assigned_at: stamp(D1, '09:00') },
    ],
    cohortLeads: [
      { conversation_id: 'c1', created_by_user_id: 'me' },
      { conversation_id: 'c3', created_by_user_id: 'other' },
    ],
  }
  const leads = [
    { conversation_id: 'c1', source: 'manual', created_by_user_id: 'me', created_at: stamp(D1, '10:50'), delivered_at: stamp(D1, '11:00') },
    { conversation_id: 'c3', source: 'manual', created_by_user_id: 'other', created_at: stamp(D1, '10:00'), delivered_at: stamp(D1, '10:05') },
    { conversation_id: 'c9', source: 'ai', created_by_user_id: null, created_at: stamp(D1, '08:00'), delivered_at: stamp(D1, '08:00') },
  ]

  it('counts only the agent\'s own chats and leads', () => {
    const s = summarizeMine(D1, D2, 'me', leads, extras)
    expect(s.received).toBe(2)
    expect(s.registered).toBe(1)
    expect(s.receivedRegistered).toBe(1)
    expect(s.rate).toBe(0.5)
    // Received at 09:00, delivered at 11:00.
    expect(s.avgMinutes).toBe(120)
  })

  it('has per-day figures of their own, with no other agent or AI numbers', () => {
    const s = summarizeMine(D1, D2, 'me', leads, extras)
    expect(s.days).toEqual([
      { day: D1, received: 1, registered: 1 },
      { day: D2, received: 1, registered: 0 },
    ])
    expect(Object.keys(s).sort()).toEqual(
      ['avgMinutes', 'days', 'rate', 'received', 'receivedRegistered', 'registered'].sort(),
    )
  })

  it('is all zeros for an agent with nothing in the range', () => {
    const s = summarizeMine(D1, D2, 'nobody', leads, extras)
    expect(s).toMatchObject({ received: 0, registered: 0, receivedRegistered: 0, rate: 0, avgMinutes: null })
  })
})
