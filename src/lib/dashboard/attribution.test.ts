import { describe, it, expect } from 'vitest'
import {
  groupByCreative,
  summarizeAttribution,
  withAdPerformance,
  type AdPerformanceRow,
  type AttributionRow,
} from './attribution'

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

const perfRow = (over: Partial<AdPerformanceRow>): AdPerformanceRow => ({
  platform_ad_id: 'a1',
  ad_name: 'Ad 1',
  campaign_id: 'c1',
  campaign_name: 'PROSPECCION',
  adset_name: 'Amplio',
  status: 'active',
  currency: 'COP',
  spend: 1000000,
  impressions: 5000,
  clicks: 100,
  meta_conversations: 80,
  ...over,
})

describe('withAdPerformance', () => {
  const base = () => summarizeAttribution(ROWS)

  it('leaves the summary alone when no ad account is synced', () => {
    const s = withAdPerformance(base(), [])
    expect(s.performance).toBeNull()
    expect(s.sources[0].spend).toBeNull()
  })

  it('attaches campaign, ad set and spend to each ad', () => {
    const s = withAdPerformance(base(), [perfRow({ platform_ad_id: 'a1' })])
    expect(s.sources[0]).toMatchObject({ key: 'a1', spend: 1000000, campaignName: 'PROSPECCION', adSetName: 'Amplio', adStatus: 'active' })
    expect(s.sources.find((x) => x.key === 'a2')?.spend).toBeNull()
  })

  it('rolls ads up per campaign with cost per conversation and per lead', () => {
    const s = withAdPerformance(base(), [
      perfRow({ platform_ad_id: 'a1', spend: 900000 }),
      perfRow({ platform_ad_id: 'a2', spend: 300000, meta_conversations: 20 }),
      perfRow({ platform_ad_id: 'b1', campaign_id: 'c2', campaign_name: 'STOCK', spend: 500000 }),
    ])
    const c1 = s.performance!.campaigns.find((c) => c.key === 'c1')!
    expect(c1).toMatchObject({ kind: 'campaign', name: 'PROSPECCION', ads: 2, conversations: 110, leads: 18, spend: 1200000, platformConversations: 100 })
    expect(c1.costPerConversation).toBeCloseTo(1200000 / 110)
    expect(c1.costPerLead).toBeCloseTo(1200000 / 18)
    expect(s.performance!.campaigns.map((c) => c.key)).toEqual(['c1', 'c2', 'organic'])
    expect(s.performance!.spend).toBe(1700000)
    // Cost per conversation only counts chats that came from ads (not the post).
    expect(s.performance!.costPerConversation).toBeCloseTo(1700000 / 145)
  })

  it('shows campaigns that spent but brought no chats, and the idle spend', () => {
    const s = withAdPerformance(base(), [
      perfRow({ platform_ad_id: 'a1' }),
      perfRow({ platform_ad_id: 'z9', campaign_id: 'c9', campaign_name: 'SIN CHATS', spend: 200000 }),
    ])
    const idle = s.performance!.campaigns.find((c) => c.key === 'c9')!
    expect(idle).toMatchObject({ conversations: 0, spend: 200000, costPerLead: null })
    expect(s.performance!.idleSpend).toBe(200000)
  })

  it('puts chats of ads the account does not know in their own group', () => {
    const s = withAdPerformance(base(), [perfRow({ platform_ad_id: 'a1' })])
    const unknown = s.performance!.campaigns.find((c) => c.kind === 'unknown')!
    expect(unknown.conversations).toBe(17 + 35)
  })

  it('merges spend when grouping by creative', () => {
    const s = withAdPerformance(
      summarizeAttribution([row({ source_id: 'a1' }), row({ source_id: 'a2' })]),
      [perfRow({ platform_ad_id: 'a1', spend: 100 }), perfRow({ platform_ad_id: 'a2', spend: 50, campaign_id: 'c2', campaign_name: 'OTRA' })],
    )
    const [g] = groupByCreative(s.sources)
    expect(g.spend).toBe(150)
    expect(g.campaignName).toBeNull()
  })
})
