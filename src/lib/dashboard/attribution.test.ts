import { describe, it, expect } from 'vitest'
import { groupByCreative, summarizeAttribution, type AttributionRow } from './attribution'

const row = (over: Partial<AttributionRow>): AttributionRow => ({
  source_type: 'ad',
  source_id: 'a1',
  headline: 'Deja de perder dinero',
  media_type: 'video',
  source_url: null,
  conversations: 10,
  leads: 2,
  ...over,
})

const ROWS: AttributionRow[] = [
  row({ source_id: 'a1', conversations: 93, leads: 15 }),
  row({ source_id: 'a2', conversations: 17, leads: 3 }),
  row({ source_id: 'b1', headline: 'Máquinas en stock', conversations: 35, leads: 13 }),
  row({ source_type: 'post', source_id: 'p1', headline: 'Publicación', source_url: 'https://www.instagram.com/p/x', conversations: 4, leads: 1 }),
  row({ source_type: 'direct', source_id: null, headline: null, media_type: null, conversations: 328, leads: 50 }),
]

describe('summarizeAttribution', () => {
  it('keeps one card per ad or post, biggest first, and the direct chats apart', () => {
    const s = summarizeAttribution(ROWS)
    expect(s.sources.map((x) => x.key)).toEqual(['a1', 'b1', 'a2', 'p1'])
    expect(s.direct).toMatchObject({ key: 'direct', kind: 'direct', conversations: 328, leads: 50 })
    expect(s.sources[0]).toMatchObject({ kind: 'ad', conversations: 93, leads: 15 })
    expect(s.sources[0].rate).toBeCloseTo(15 / 93)
  })

  it('totals the attributed chats and all chats separately', () => {
    const s = summarizeAttribution(ROWS)
    expect(s.attributed).toMatchObject({ conversations: 149, leads: 32 })
    expect(s.attributed.rate).toBeCloseTo(32 / 149)
    expect(s.total).toMatchObject({ conversations: 477, leads: 82 })
  })

  it('tells organic posts from ads and only keeps real links', () => {
    const s = summarizeAttribution(ROWS)
    const post = s.sources.find((x) => x.kind === 'post')
    expect(post?.url).toBe('https://www.instagram.com/p/x')
    const bad = summarizeAttribution([row({ source_url: 'javascript:alert(1)' })])
    expect(bad.sources[0].url).toBeNull()
  })

  it('treats an unknown source type as direct and handles no data', () => {
    expect(summarizeAttribution([row({ source_type: 'weird', source_id: null })]).direct?.conversations).toBe(10)
    const empty = summarizeAttribution([])
    expect(empty.sources).toEqual([])
    expect(empty.direct).toBeNull()
    expect(empty.total).toEqual({ conversations: 0, leads: 0, rate: 0 })
  })

  it('accepts counts that arrive as text (bigint)', () => {
    const s = summarizeAttribution([row({ conversations: '12' as unknown as number, leads: '3' as unknown as number })])
    expect(s.sources[0]).toMatchObject({ conversations: 12, leads: 3 })
  })
})

describe('groupByCreative', () => {
  it('merges the ads that share the same text, adding their numbers', () => {
    const s = summarizeAttribution(ROWS)
    const grouped = groupByCreative(s.sources)
    expect(grouped).toHaveLength(3)
    expect(grouped[0]).toMatchObject({ conversations: 110, leads: 18, sourceIds: ['a1', 'a2'] })
    expect(grouped[0].rate).toBeCloseTo(18 / 110)
  })

  it('never merges an ad with a post, or ads without a headline', () => {
    const grouped = groupByCreative(
      summarizeAttribution([
        row({ source_id: 'x1', headline: 'Igual' }),
        row({ source_type: 'post', source_id: 'x2', headline: 'Igual' }),
        row({ source_id: 'x3', headline: null }),
        row({ source_id: 'x4', headline: null }),
      ]).sources,
    )
    expect(grouped).toHaveLength(4)
  })
})
