// What the person was looking at in the inbox list, so a reload, a deploy or
// a remount does not send her back to the top with the filters cleared.

export const LIST_STATE_STORAGE_KEY = 'wacrm:inbox:list-state'

export type SavedListFilter = 'all' | 'unread' | 'open' | 'pending' | 'closed' | 'blocked'

export interface SavedListState {
  filter: SavedListFilter
  search: string
  tagIds: string[]
  company: string | null
  /** A stage id, "none" (conversations without a stage) or null (any). */
  stageId: string | null
}

export const DEFAULT_LIST_STATE: SavedListState = {
  filter: 'all',
  search: '',
  tagIds: [],
  company: null,
  stageId: null,
}

const FILTERS: SavedListFilter[] = ['all', 'unread', 'open', 'pending', 'closed', 'blocked']

/** The saved state, or null when there is none or it is not usable. */
export function parseSavedListState(raw: string | null | undefined): SavedListState | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<SavedListState> | null
    if (!v || typeof v !== 'object') return null
    return {
      filter: FILTERS.includes(v.filter as SavedListFilter) ? (v.filter as SavedListFilter) : 'all',
      search: typeof v.search === 'string' ? v.search.slice(0, 200) : '',
      tagIds: Array.isArray(v.tagIds) ? v.tagIds.filter((x): x is string => typeof x === 'string') : [],
      company: typeof v.company === 'string' ? v.company : null,
      stageId: typeof v.stageId === 'string' ? v.stageId : null,
    }
  } catch {
    return null
  }
}

/**
 * The conversation to open when moving one step down (1) or up (-1) the
 * visible list. When the open conversation is no longer in the list (it
 * changed status or was handed over while the person answered it), the next
 * one has slid into its place, so "next" is the item at its last position
 * and "previous" the one before it.
 */
export function neighbourId(
  ids: string[],
  activeId: string | null,
  lastIndex: number,
  direction: 1 | -1,
): string | null {
  if (ids.length === 0) return null
  const index = activeId ? ids.indexOf(activeId) : -1
  let target: number
  if (index >= 0) target = index + direction
  else if (activeId) target = direction === 1 ? lastIndex : lastIndex - 1
  else target = direction === 1 ? 0 : ids.length - 1
  if (target < 0 || target >= ids.length) return null
  return ids[target]
}
