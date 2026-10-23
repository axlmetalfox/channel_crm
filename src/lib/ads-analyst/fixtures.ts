import { addDays, analysisWindows, buildSnapshot } from './snapshot'
import type { AttributionInput, CatalogAd, DailyRow } from './types'

export const TODAY = '2026-10-22'

export function catalogAd(id: string, over: Partial<CatalogAd> = {}): CatalogAd {
  return {
    platform_ad_id: id,
    ad_name: `ad ${id}`,
    campaign_id: 'c1',
    campaign_name: 'CAMPAÑA 1',
    adset_name: `conjunto ${id}`,
    status: 'active',
    currency: 'COP',
    ...over,
  }
}

/** Same numbers on every day of [from, to]. */
export function days(id: string, from: string, to: string, perDay: Partial<DailyRow> = {}): DailyRow[] {
  const out: DailyRow[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push({ platform_ad_id: id, day: d, spend: 10000, impressions: 1000, clicks: 20, conversations_started: 1, ...perDay })
  }
  return out
}

export const w = analysisWindows(TODAY, 14)
export const START = '2026-09-01'

export interface AdSpec {
  id: string
  catalog?: Partial<CatalogAd>
  /** Daily spend in the current / previous window. */
  spend?: number
  prevSpend?: number
  chats?: number
  leads?: number
  prevChats?: number
  prevLeads?: number
  headline?: string
  metaChats?: number
}

export function snapshotOf(specs: AdSpec[]) {
  const catalog: CatalogAd[] = []
  const daily: DailyRow[] = []
  const current: AttributionInput[] = []
  const previous: AttributionInput[] = []
  for (const s of specs) {
    catalog.push(catalogAd(s.id, s.catalog))
    // Old enough to be judged: spending since September.
    daily.push(...days(s.id, START, w.previous.to, { spend: s.prevSpend ?? 10000, conversations_started: 0 }))
    daily.push(
      ...days(s.id, w.current.from, w.current.to, {
        spend: s.spend ?? 10000,
        conversations_started: (s.metaChats ?? s.chats ?? 0) / 14,
      }),
    )
    const head = s.headline ?? `Titular ${s.id}`
    if (s.chats !== undefined) current.push({ source_type: 'ad', source_id: s.id, headline: head, conversations: s.chats, leads: s.leads ?? 0 })
    if (s.prevChats !== undefined) previous.push({ source_type: 'ad', source_id: s.id, headline: head, conversations: s.prevChats, leads: s.prevLeads ?? 0 })
  }
  return buildSnapshot({ today: TODAY, catalog, daily, attribution: { current, previous } })
}

// Three ordinary ads set the account's references: 140.000 spent each, 28 chats,
// 7 leads -> 5.000 per chat, 20.000 per lead, 25 % of chats become leads.
export const BASE: AdSpec[] = [
  { id: 'n1', chats: 28, leads: 7 },
  { id: 'n2', chats: 28, leads: 7 },
  { id: 'n3', chats: 28, leads: 7 },
]
