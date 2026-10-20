import { describe, it, expect, vi, beforeEach } from 'vitest'

const addAndDispatch = vi.fn()
vi.mock('./tag-events', () => ({
  addContactTagAndDispatch: (...args: unknown[]) => addAndDispatch(...args),
}))

import { bulkSetContactTag } from './tag-bulk'
import { ContactTagWriteError } from './tag-write'

interface FakeState {
  tag: { id: string } | null
  visibleContacts: string[]
  deleted: { tag_id?: string; contact_ids?: string[] }
  deletedRows: number
  deleteError: string | null
}

function fakeDb(state: FakeState) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      if (table === 'tags') {
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = () => Promise.resolve({ data: state.tag, error: null })
      } else if (table === 'contacts') {
        b.select = () => b
        b.eq = () => b
        b.in = (_col: string, ids: string[]) =>
          Promise.resolve({
            data: ids.filter((id) => state.visibleContacts.includes(id)).map((id) => ({ id })),
            error: null,
          })
      } else if (table === 'contact_tags') {
        b.delete = () => b
        b.eq = (_col: string, tagId: string) => {
          state.deleted.tag_id = tagId
          return b
        }
        b.in = (_col: string, ids: string[]) => {
          state.deleted.contact_ids = ids
          return b
        }
        b.select = () =>
          Promise.resolve(
            state.deleteError
              ? { data: null, error: { message: state.deleteError } }
              : { data: Array.from({ length: state.deletedRows }, (_, i) => ({ id: String(i) })), error: null }
          )
      } else {
        throw new Error(`unexpected table ${table}`)
      }
      return b
    },
  } as never
}

function baseState(over: Partial<FakeState> = {}): FakeState {
  return {
    tag: { id: 'tag-1' },
    visibleContacts: ['c1', 'c2', 'c3'],
    deleted: {},
    deletedRows: 2,
    deleteError: null,
    ...over,
  }
}

describe('bulkSetContactTag', () => {
  beforeEach(() => {
    addAndDispatch.mockReset()
  })

  it('removes the tag in one delete, only from contacts the person can see', async () => {
    const state = baseState({ deletedRows: 2 })
    const result = await bulkSetContactTag(fakeDb(state), {
      accountId: 'acc',
      contactIds: ['c1', 'c2', 'hidden', 'c1'],
      tagId: 'tag-1',
      action: 'remove',
    })
    expect(state.deleted).toEqual({ tag_id: 'tag-1', contact_ids: ['c1', 'c2'] })
    expect(result).toEqual({ matched: 2, added: 0, removed: 2 })
    expect(addAndDispatch).not.toHaveBeenCalled()
  })

  it('does nothing when no contact is visible', async () => {
    const state = baseState({ visibleContacts: [] })
    const result = await bulkSetContactTag(fakeDb(state), {
      accountId: 'acc',
      contactIds: ['x'],
      tagId: 'tag-1',
      action: 'remove',
    })
    expect(result).toEqual({ matched: 0, added: 0, removed: 0 })
    expect(state.deleted).toEqual({})
  })

  it('adds the tag per contact through the dispatching writer and counts new ones', async () => {
    addAndDispatch
      .mockResolvedValueOnce({ added: true, dispatched: true })
      .mockResolvedValueOnce({ added: false, dispatched: false, reason: 'duplicate' })
    const result = await bulkSetContactTag(fakeDb(baseState()), {
      accountId: 'acc',
      contactIds: ['c1', 'c2'],
      tagId: 'tag-1',
      action: 'add',
    })
    expect(addAndDispatch).toHaveBeenCalledTimes(2)
    expect(addAndDispatch.mock.calls[0][0]).toMatchObject({ accountId: 'acc', contactId: 'c1', tagId: 'tag-1' })
    expect(result).toEqual({ matched: 2, added: 1, removed: 0 })
  })

  it('rejects a tag from another account', async () => {
    await expect(
      bulkSetContactTag(fakeDb(baseState({ tag: null })), {
        accountId: 'acc',
        contactIds: ['c1'],
        tagId: 'foreign',
        action: 'remove',
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it('surfaces a failed delete', async () => {
    await expect(
      bulkSetContactTag(fakeDb(baseState({ deleteError: 'boom' })), {
        accountId: 'acc',
        contactIds: ['c1'],
        tagId: 'tag-1',
        action: 'remove',
      })
    ).rejects.toBeInstanceOf(ContactTagWriteError)
  })
})
