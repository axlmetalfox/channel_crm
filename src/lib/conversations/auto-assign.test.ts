import { describe, it, expect, beforeEach } from 'vitest'
import { roundRobin, runAutoAssign } from './auto-assign'

describe('roundRobin', () => {
  const agents = ['a', 'b', 'c']
  it('starts with the first agent when nobody was assigned yet', () => {
    expect(roundRobin(agents, null, 4)).toEqual(['a', 'b', 'c', 'a'])
  })
  it('continues after the agent who got the last one', () => {
    expect(roundRobin(agents, 'b', 4)).toEqual(['c', 'a', 'b', 'c'])
    expect(roundRobin(agents, 'c', 2)).toEqual(['a', 'b'])
  })
  it('starts over when the cursor agent left the team', () => {
    expect(roundRobin(agents, 'gone', 2)).toEqual(['a', 'b'])
  })
  it('handles an empty team and a zero count', () => {
    expect(roundRobin([], null, 3)).toEqual([])
    expect(roundRobin(agents, null, 0)).toEqual([])
  })
})

describe('runAutoAssign', () => {
  const state = {
    accounts: [] as Record<string, unknown>[],
    schedule: null as unknown,
    agents: ['a', 'b'] as string[],
    stalled: ['c1', 'c2', 'c3'] as string[],
    taken: new Set<string>(),
    assignments: [] as { id: string; agent: string }[],
    cursor: undefined as string | undefined,
    lt: undefined as string | undefined,
  }

  function fakeDb() {
    return {
      from(table: string) {
        let mode: 'select' | 'update' = 'select'
        let values: Record<string, unknown> = {}
        const filters: Record<string, unknown> = {}
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'in', 'not', 'order', 'limit', 'is']) b[m] = () => b
        b.eq = (c: string, v: unknown) => ((filters[c] = v), b)
        b.lt = (_c: string, v: string) => ((state.lt = v), b)
        b.update = (v: Record<string, unknown>) => ((mode = 'update'), (values = v), b)
        const result = () => {
          if (table === 'accounts' && mode === 'select') return { data: state.accounts }
          if (table === 'accounts' && mode === 'update') {
            state.cursor = values.auto_assign_cursor as string
            return { data: null }
          }
          if (table === 'profiles') return { data: state.agents.map((user_id) => ({ user_id })) }
          if (table === 'conversations' && mode === 'select') {
            return { data: state.stalled.map((id) => ({ id })) }
          }
          if (table === 'conversations' && mode === 'update') {
            const id = filters.id as string
            if (state.taken.has(id)) return { data: [] }
            state.assignments.push({ id, agent: values.assigned_agent_id as string })
            return { data: [{ id }] }
          }
          return { data: null }
        }
        b.maybeSingle = () => Promise.resolve({ data: table === 'ai_configs' ? { auto_reply_schedule: state.schedule } : null })
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok)
        return b
      },
    } as never
  }

  const NOW = new Date('2026-10-16T17:00:00Z') // Friday 12:00 in Bogotá: office hours

  beforeEach(() => {
    state.accounts = [{ id: 'acct', auto_assign_after_minutes: 60, auto_assign_cursor: null }]
    state.schedule = null
    state.agents = ['a', 'b']
    state.stalled = ['c1', 'c2', 'c3']
    state.taken = new Set()
    state.assignments = []
    state.cursor = undefined
    state.lt = undefined
  })

  it('hands stalled conversations to the agents in turns and remembers where it stopped', async () => {
    const out = await runAutoAssign(fakeDb(), NOW)
    expect(out.assigned).toBe(3)
    expect(state.assignments).toEqual([
      { id: 'c1', agent: 'a' },
      { id: 'c2', agent: 'b' },
      { id: 'c3', agent: 'a' },
    ])
    expect(state.cursor).toBe('a')
    // Only conversations idle for at least the configured wait qualify.
    expect(state.lt).toBe('2026-10-16T16:00:00.000Z')
  })

  it('continues the rotation from the saved cursor', async () => {
    state.accounts = [{ id: 'acct', auto_assign_after_minutes: 60, auto_assign_cursor: 'a' }]
    await runAutoAssign(fakeDb(), NOW)
    expect(state.assignments.map((a) => a.agent)).toEqual(['b', 'a', 'b'])
  })

  it('does not break the rotation when someone else took a conversation meanwhile', async () => {
    state.taken = new Set(['c1'])
    const out = await runAutoAssign(fakeDb(), NOW)
    expect(out.assigned).toBe(2)
    expect(state.assignments).toEqual([
      { id: 'c2', agent: 'a' },
      { id: 'c3', agent: 'b' },
    ])
  })

  it('assigns nothing while the AI agent is on duty (nobody is at the desks)', async () => {
    state.schedule = {
      timezone: 'America/Bogota',
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }],
    }
    expect((await runAutoAssign(fakeDb(), NOW)).assigned).toBe(0)
    expect(state.assignments).toHaveLength(0)
  })

  it('assigns during office hours when a schedule exists', async () => {
    state.schedule = {
      timezone: 'America/Bogota',
      windows: [{ days: [1, 2, 3, 4], start: '17:00', end: '07:30' }],
    }
    expect((await runAutoAssign(fakeDb(), NOW)).assigned).toBe(3)
  })

  it('does nothing without agents or without enabled accounts', async () => {
    state.agents = []
    expect((await runAutoAssign(fakeDb(), NOW)).assigned).toBe(0)
    state.agents = ['a']
    state.accounts = []
    expect((await runAutoAssign(fakeDb(), NOW)).assigned).toBe(0)
  })
})
