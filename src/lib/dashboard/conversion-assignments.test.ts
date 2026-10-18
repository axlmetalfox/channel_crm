import { describe, it, expect } from 'vitest'
import { summarizeConversion } from './conversion'

const stamp = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00`).toISOString()
const D = '2026-10-19'

describe('effectiveness by agent', () => {
  const assignments = [
    { conversation_id: 'c1', agent_id: 'u1', assigned_at: stamp(D, '09:00') },
    { conversation_id: 'c2', agent_id: 'u1', assigned_at: stamp(D, '09:30') },
    { conversation_id: 'c3', agent_id: 'u1', assigned_at: stamp(D, '10:00') },
    { conversation_id: 'c4', agent_id: 'u2', assigned_at: stamp(D, '10:00') },
    // Outside the range: not received in it.
    { conversation_id: 'c9', agent_id: 'u1', assigned_at: stamp('2026-10-10', '10:00') },
  ]

  it('divides the chats each agent registered by the ones they received', () => {
    const s = summarizeConversion(D, D, [], [], {
      aiConversationIds: [],
      firstHumanMessageAt: {},
      names: { u1: 'Elcy', u2: 'Carolina' },
      assignments,
      cohortLeads: [
        { conversation_id: 'c1', created_by_user_id: 'u1' },
        { conversation_id: 'c1', created_by_user_id: 'u1' },
        { conversation_id: 'c3', created_by_user_id: 'u1' },
        // Registered by someone else: does not count for u2.
        { conversation_id: 'c4', created_by_user_id: 'u1' },
        // Chat u1 did not receive in the range.
        { conversation_id: 'c9', created_by_user_id: 'u1' },
      ],
    })
    expect(s.agents).toEqual([
      { userId: 'u1', name: 'Elcy', registered: 0, received: 3, receivedRegistered: 2, rate: 2 / 3, avgMinutes: null },
      { userId: 'u2', name: 'Carolina', registered: 0, received: 1, receivedRegistered: 0, rate: 0, avgMinutes: null },
    ])
  })

  it('lists an agent who received chats but registered none', () => {
    const s = summarizeConversion(D, D, [], [], {
      aiConversationIds: [],
      firstHumanMessageAt: {},
      names: {},
      assignments: [{ conversation_id: 'c1', agent_id: 'u1', assigned_at: stamp(D, '09:00') }],
    })
    expect(s.agents).toHaveLength(1)
    expect(s.agents[0]).toMatchObject({ received: 1, rate: 0 })
  })

  it('counts a chat once for an agent even when it was assigned to them twice', () => {
    const s = summarizeConversion(D, D, [], [], {
      aiConversationIds: [],
      firstHumanMessageAt: {},
      names: {},
      assignments: [
        { conversation_id: 'c1', agent_id: 'u1', assigned_at: stamp(D, '09:00') },
        { conversation_id: 'c1', agent_id: 'u1', assigned_at: stamp(D, '11:00') },
      ],
    })
    expect(s.agents[0].received).toBe(1)
  })
})

describe('registration time from the assignment', () => {
  it('counts from when the agent received the chat', () => {
    const s = summarizeConversion(
      D,
      D,
      [],
      [
        {
          conversation_id: 'c1', source: 'manual', created_by_user_id: 'u1',
          created_at: stamp(D, '10:55'), delivered_at: stamp(D, '11:00'),
        },
      ],
      {
        aiConversationIds: [],
        // The agent wrote at 10:30, but got the chat at 10:00.
        firstHumanMessageAt: { c1: stamp(D, '10:30') },
        names: {},
        assignments: [{ conversation_id: 'c1', agent_id: 'u1', assigned_at: stamp(D, '10:00') }],
      },
    )
    expect(s.agents[0].avgMinutes).toBe(60)
  })

  it('uses the latest assignment before the lead, and ignores one made after', () => {
    const s = summarizeConversion(
      D,
      D,
      [],
      [
        {
          conversation_id: 'c1', source: 'manual', created_by_user_id: 'u1',
          created_at: stamp(D, '10:55'), delivered_at: stamp(D, '11:00'),
        },
      ],
      {
        aiConversationIds: [],
        firstHumanMessageAt: {},
        names: {},
        assignments: [
          { conversation_id: 'c1', agent_id: 'u1', assigned_at: stamp(D, '09:00') },
          { conversation_id: 'c1', agent_id: 'u1', assigned_at: stamp(D, '10:30') },
          { conversation_id: 'c1', agent_id: 'u1', assigned_at: stamp(D, '12:00') },
        ],
      },
    )
    expect(s.agents[0].avgMinutes).toBe(30)
  })
})
