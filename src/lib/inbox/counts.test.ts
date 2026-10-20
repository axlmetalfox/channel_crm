import { describe, it, expect } from 'vitest'
import { loadInboxCounts } from './counts'

function fakeDb(counts: Record<string, number | null>, failFor?: string) {
  const seen: string[] = []
  const db = {
    from(table: string) {
      expect(table).toBe('conversations')
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (_col: string, status: string) => {
        seen.push(status)
        return Promise.resolve({ count: counts[status], error: status === failFor ? new Error('boom') : null })
      }
      return b
    },
  }
  return { db: db as never, seen }
}

describe('loadInboxCounts', () => {
  it('counts open and pending conversations separately', async () => {
    const { db, seen } = fakeDb({ open: 7, pending: 12 })
    expect(await loadInboxCounts(db)).toEqual({ open: 7, pending: 12 })
    expect(seen.sort()).toEqual(['open', 'pending'])
  })

  it('treats a missing count as zero', async () => {
    const { db } = fakeDb({ open: null, pending: 0 })
    expect(await loadInboxCounts(db)).toEqual({ open: 0, pending: 0 })
  })

  it('fails loudly so the header can keep its last numbers', async () => {
    const { db } = fakeDb({ open: 1, pending: 1 }, 'pending')
    await expect(loadInboxCounts(db)).rejects.toThrow('boom')
  })
})
