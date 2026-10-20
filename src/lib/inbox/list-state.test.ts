import { describe, it, expect } from 'vitest'
import { DEFAULT_LIST_STATE, neighbourId, parseSavedListState } from './list-state'

describe('parseSavedListState', () => {
  it('reads back what was saved', () => {
    const saved = { filter: 'open', search: 'ana', tagIds: ['t1'], company: 'Lácteos', stageId: 'none' }
    expect(parseSavedListState(JSON.stringify(saved))).toEqual(saved)
  })

  it('falls back to safe values for unknown or broken fields', () => {
    expect(parseSavedListState(JSON.stringify({ filter: 'weird', tagIds: [1, 'x'], search: 5 }))).toEqual({
      ...DEFAULT_LIST_STATE,
      tagIds: ['x'],
    })
  })

  it('returns null when there is nothing usable', () => {
    expect(parseSavedListState(null)).toBeNull()
    expect(parseSavedListState('')).toBeNull()
    expect(parseSavedListState('not json')).toBeNull()
    expect(parseSavedListState('null')).toBeNull()
  })
})

describe('neighbourId', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves one step down or up from the open conversation', () => {
    expect(neighbourId(ids, 'b', 1, 1)).toBe('c')
    expect(neighbourId(ids, 'b', 1, -1)).toBe('a')
  })

  it('stops at the ends of the list', () => {
    expect(neighbourId(ids, 'd', 3, 1)).toBeNull()
    expect(neighbourId(ids, 'a', 0, -1)).toBeNull()
  })

  it('when the open one left the list, next is whoever slid into its place', () => {
    // "b" (index 1) was answered and left the filter: the list is now a, c, d
    const after = ['a', 'c', 'd']
    expect(neighbourId(after, 'b', 1, 1)).toBe('c')
    expect(neighbourId(after, 'b', 1, -1)).toBe('a')
  })

  it('when the last one left the list, there is no next but there is a previous', () => {
    const after = ['a', 'b', 'c']
    expect(neighbourId(after, 'd', 3, 1)).toBeNull()
    expect(neighbourId(after, 'd', 3, -1)).toBe('c')
  })

  it('with nothing open it starts at the top, or the bottom going up', () => {
    expect(neighbourId(ids, null, 0, 1)).toBe('a')
    expect(neighbourId(ids, null, 0, -1)).toBe('d')
    expect(neighbourId([], null, 0, 1)).toBeNull()
  })
})
