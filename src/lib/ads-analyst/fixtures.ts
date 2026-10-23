import { addDays } from './snapshot'
import type { CatalogAd, DailyRow } from './types'

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
