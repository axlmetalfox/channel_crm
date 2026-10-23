import { describe, it, expect } from 'vitest'
import { addDays, analysisWindows, buildSnapshot, daysBetween } from './snapshot'
import { catalogAd, days, TODAY } from './fixtures'

describe('analysisWindows', () => {
  it('ends yesterday and puts the previous window right before', () => {
    const w = analysisWindows(TODAY, 14)
    expect(w.current).toEqual({ from: '2026-10-08', to: '2026-10-21' })
    expect(w.previous).toEqual({ from: '2026-09-24', to: '2026-10-07' })
  })

  it('does arithmetic on calendar days across month ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(daysBetween('2026-10-01', '2026-10-22')).toBe(21)
  })
})

describe('buildSnapshot', () => {
  const w = analysisWindows(TODAY, 14)

  it('sums each window apart and joins chats and leads by ad id', () => {
    const snap = buildSnapshot({
      today: TODAY,
      catalog: [catalogAd('a1')],
      daily: [...days('a1', w.current.from, w.current.to), ...days('a1', w.previous.from, w.previous.to, { spend: 5000 })],
      attribution: {
        current: [{ source_type: 'ad', source_id: 'a1', headline: ' Titular ', conversations: 20, leads: 4 }],
        previous: [{ source_type: 'ad', source_id: 'a1', headline: 'Titular', conversations: 10, leads: 1 }],
      },
    })
    const ad = snap.ads[0]
    expect(ad.current).toMatchObject({ spend: 140000, conversations: 20, leads: 4, spendDays: 14, platformConversations: 14 })
    expect(ad.current.costPerConversation).toBe(7000)
    expect(ad.current.costPerLead).toBe(35000)
    expect(ad.current.leadRate).toBeCloseTo(0.2)
    expect(ad.previous).toMatchObject({ spend: 70000, conversations: 10, leads: 1 })
    expect(ad.headline).toBe('Titular')
    expect(ad.campaignName).toBe('CAMPAÑA 1')
  })

  it('computes the age from the first day with spend and keeps ratios null with no denominator', () => {
    const snap = buildSnapshot({
      today: TODAY,
      catalog: [catalogAd('a1')],
      daily: days('a1', '2026-10-18', '2026-10-21'),
      attribution: { current: [], previous: [] },
    })
    expect(snap.ads[0].ageDays).toBe(4)
    expect(snap.ads[0].current.costPerConversation).toBeNull()
    expect(snap.ads[0].current.costPerLead).toBeNull()
    expect(snap.ads[0].previous.spend).toBe(0)
  })

  it('rolls ads up per campaign and the account, and counts direct chats apart', () => {
    const snap = buildSnapshot({
      today: TODAY,
      catalog: [catalogAd('a1'), catalogAd('a2'), catalogAd('b1', { campaign_id: 'c2', campaign_name: 'CAMPAÑA 2', status: 'paused' })],
      daily: [
        ...days('a1', w.current.from, w.current.to),
        ...days('a2', w.current.from, w.current.to, { spend: 20000 }),
        ...days('b1', w.current.from, w.current.to, { spend: 1000 }),
      ],
      attribution: {
        current: [
          { source_type: 'ad', source_id: 'a1', headline: 'x', conversations: 10, leads: 2 },
          { source_type: 'ad', source_id: 'a2', headline: 'y', conversations: 5, leads: 1 },
          { source_type: 'post', source_id: 'p1', headline: 'p', conversations: 4, leads: 1 },
          { source_type: 'direct', source_id: null, headline: null, conversations: 50, leads: 9 },
        ],
        previous: [],
      },
    })
    expect(snap.campaigns.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(snap.campaigns[0]).toMatchObject({ adCount: 2, status: 'active' })
    expect(snap.campaigns[1].status).toBe('paused')
    // Posts are not ads: they stay out of the account's ad numbers.
    expect(snap.account.current).toMatchObject({ conversations: 15, leads: 3 })
    expect(snap.account.current.spend).toBe(140000 + 280000 + 14000)
    expect(snap.account.directConversations.current).toBe(50)
  })

  it('keeps ads that only have chats, and drops ads with nothing in either window', () => {
    const snap = buildSnapshot({
      today: TODAY,
      catalog: [catalogAd('old')],
      daily: days('old', '2026-06-01', '2026-06-10'),
      attribution: {
        current: [{ source_type: 'ad', source_id: 'ghost', headline: 'g', conversations: 3, leads: 0 }],
        previous: [],
      },
    })
    expect(snap.ads.map((a) => a.id)).toEqual(['ghost'])
    expect(snap.ads[0].campaignId).toBeNull()
    expect(snap.campaigns[0].id).toBe('unknown')
  })

  it('leaves out spend from before attribution existed, so chats are not undercounted', () => {
    const snap = buildSnapshot({
      today: TODAY,
      catalog: [catalogAd('a1')],
      daily: days('a1', w.previous.from, w.current.to),
      attribution: {
        current: [{ source_type: 'ad', source_id: 'a1', headline: 'x', conversations: 9, leads: 2 }],
        previous: [],
      },
      attributionSince: '2026-10-13',
    })
    expect(snap.coverage).toEqual({ attributionSince: '2026-10-13', currentDays: 9, previousDays: 0, previousComplete: false })
    expect(snap.ads[0].current.spend).toBe(90000)
    expect(snap.ads[0].current.spendDays).toBe(9)
    expect(snap.ads[0].previous.spend).toBe(0)
  })

  it('counts the whole windows when attribution covers them', () => {
    const snap = buildSnapshot({
      today: TODAY,
      catalog: [catalogAd('a1')],
      daily: days('a1', w.previous.from, w.current.to),
      attribution: { current: [], previous: [] },
      attributionSince: '2026-09-01',
    })
    expect(snap.coverage).toMatchObject({ currentDays: 14, previousDays: 14, previousComplete: true })
  })
})
