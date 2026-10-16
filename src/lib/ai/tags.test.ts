import { describe, it, expect } from 'vitest'
import { setOfficeHoursTag } from './tags'

function fakeDb(tagId: string | null) {
  const ops: { table: string; op: string; values?: unknown; filters: [string, unknown][] }[] = []
  const db = {
    from(table: string) {
      const rec: (typeof ops)[number] = { table, op: 'select', filters: [] }
      ops.push(rec)
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => (rec.filters.push([c, v]), b)
      b.limit = () => b
      b.maybeSingle = () => Promise.resolve({ data: tagId ? { id: tagId } : null })
      b.upsert = (v: unknown) => ((rec.op = 'upsert'), (rec.values = v), Promise.resolve({ error: null }))
      b.delete = () => ((rec.op = 'delete'), b)
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok)
      return b
    },
  } as never
  return { db, ops }
}

const base = { accountId: 'acct', contactId: 'ct', tagName: 'Horario_laboral' }

describe('setOfficeHoursTag', () => {
  it('adds the tag to the contact', async () => {
    const { db, ops } = fakeDb('tag-1')
    await setOfficeHoursTag(db, { ...base, on: true })
    const upsert = ops.find((o) => o.op === 'upsert')
    expect(upsert?.table).toBe('contact_tags')
    expect(upsert?.values).toEqual({ contact_id: 'ct', tag_id: 'tag-1' })
  })

  it('removes the tag from the contact', async () => {
    const { db, ops } = fakeDb('tag-1')
    await setOfficeHoursTag(db, { ...base, on: false })
    const del = ops.find((o) => o.op === 'delete')
    expect(del?.table).toBe('contact_tags')
    expect(del?.filters).toEqual([
      ['contact_id', 'ct'],
      ['tag_id', 'tag-1'],
    ])
  })

  it('does nothing when the account never created the tag', async () => {
    const { db, ops } = fakeDb(null)
    await setOfficeHoursTag(db, { ...base, on: true })
    expect(ops.filter((o) => o.table === 'contact_tags')).toHaveLength(0)
  })
})
