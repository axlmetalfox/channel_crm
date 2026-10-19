import { describe, it, expect, beforeEach } from 'vitest'
import { runScheduledAssign } from './auto-assign'

describe('runScheduledAssign', () => {
  const NOW = new Date('2026-10-19T19:30:00.000Z')
  const state = {
    due: [] as Record<string, unknown>[],
    agents: ['a', 'b', 'c'] as string[],
    stalled: [] as string[],
    taken: new Set<string>(),
    claimWins: true,
    assignments: [] as { id: string; agent: string }[],
    cursor: undefined as string | undefined,
    result: undefined as Record<string, unknown> | undefined,
    cleared: false,
    stalledFilters: [] as [string, unknown][],
  }

  function fakeDb() {
    return {
      from(table: string) {
        let mode: 'select' | 'update' = 'select'
        let values: Record<string, unknown> = {}
        const filters: Record<string, unknown> = {}
        const b: Record<string, unknown> = {}
        for (const m of ['select', 'in', 'not', 'lte', 'is', 'order']) b[m] = () => b
        b.eq = (c: string, v: unknown) => {
          filters[c] = v
          if (table === 'conversations') state.stalledFilters.push([c, v])
          return b
        }
        b.lt = () => b
        b.gte = () => b
        b.range = (from: number, to: number) => {
          filters.__from = from
          filters.__to = to
          return b
        }
        b.update = (v: Record<string, unknown>) => ((mode = 'update'), (values = v), b)
        const result = () => {
          if (table === 'accounts' && mode === 'select') return { data: state.due }
          if (table === 'accounts' && mode === 'update') {
            if ('auto_assign_once_at' in values) {
              state.cleared = true
              return { data: state.claimWins ? [{ id: 'acct-1' }] : [] }
            }
            if ('auto_assign_cursor' in values) state.cursor = values.auto_assign_cursor as string
            if ('auto_assign_once_result' in values) state.result = values.auto_assign_once_result as Record<string, unknown>
            return { data: null }
          }
          if (table === 'profiles') return { data: state.agents.map((user_id) => ({ user_id })) }
          if (table === 'conversations' && mode === 'select') {
            const from = (filters.__from as number) ?? 0
            const to = (filters.__to as number) ?? 999
            return { data: state.stalled.slice(from, to + 1).map((id) => ({ id })) }
          }
          if (table === 'conversations' && mode === 'update') {
            const id = filters.id as string
            if (state.taken.has(id)) return { data: [] }
            state.assignments.push({ id, agent: values.assigned_agent_id as string })
            return { data: [{ id }] }
          }
          return { data: null }
        }
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok)
        return b
      },
    } as never
  }

  beforeEach(() => {
    state.due = [
      {
        id: 'acct-1',
        auto_assign_after_minutes: 60,
        auto_assign_cursor: null,
        auto_assign_max_age_days: 7,
        auto_assign_batch_per_agent: 3,
        auto_assign_once_at: '2026-10-19T19:30:00+00:00',
      },
    ]
    state.agents = ['a', 'b', 'c']
    state.stalled = Array.from({ length: 10 }, (_, i) => `c${i + 1}`)
    state.taken = new Set()
    state.claimWins = true
    state.assignments = []
    state.cursor = undefined
    state.result = undefined
    state.cleared = false
    state.stalledFilters = []
  })

  it('hands out everything equally in one go, ignoring the batch size, and records the result', async () => {
    expect(await runScheduledAssign(fakeDb(), NOW)).toEqual({ assigned: 10 })
    const per = (agent: string) => state.assignments.filter((x) => x.agent === agent).length
    expect([per('a'), per('b'), per('c')].sort()).toEqual([3, 3, 4])
    expect(state.cursor).toBe('a') // the 10th conversation went to the first agent again
    expect(state.result).toMatchObject({ assigned: 10, per_agent: { a: 4, b: 3, c: 3 } })
    expect(state.cleared).toBe(true)
  })

  it('looks at open and pending unassigned chats of that account', async () => {
    await runScheduledAssign(fakeDb(), NOW)
    expect(state.stalledFilters).toContainEqual(['account_id', 'acct-1'])
  })

  it('does nothing when the claim is lost to another sweep', async () => {
    state.claimWins = false
    expect(await runScheduledAssign(fakeDb(), NOW)).toEqual({ assigned: 0 })
    expect(state.assignments).toEqual([])
    expect(state.result).toBeUndefined()
  })

  it('leaves chats a person took meanwhile and spreads the rest', async () => {
    state.taken = new Set(['c1', 'c2'])
    expect(await runScheduledAssign(fakeDb(), NOW)).toEqual({ assigned: 8 })
    expect(state.assignments.map((x) => x.id)).not.toContain('c1')
  })

  it('records why nothing was assigned', async () => {
    state.agents = []
    await runScheduledAssign(fakeDb(), NOW)
    expect(state.result).toMatchObject({ assigned: 0, reason: 'no_agents' })
    state.agents = ['a']
    state.stalled = []
    await runScheduledAssign(fakeDb(), NOW)
    expect(state.result).toMatchObject({ assigned: 0, reason: 'nothing_to_assign' })
  })

  it('does nothing when no schedule is due', async () => {
    state.due = []
    expect(await runScheduledAssign(fakeDb(), NOW)).toEqual({ assigned: 0 })
    expect(state.result).toBeUndefined()
  })
})
