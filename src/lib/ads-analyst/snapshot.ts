import type {
  AdSnapshot,
  AttributionInput,
  CampaignSnapshot,
  Metrics,
  Snapshot,
  SnapshotInput,
  WindowRange,
  Windows,
} from './types'

const DEFAULT_DAYS = 14

/** Add (or subtract) calendar days to a YYYY-MM-DD, without time zones getting in the way. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/**
 * The two windows the analysis compares. They end yesterday (today's numbers
 * are still coming in) and sit back to back: current = the last `days` days,
 * previous = the `days` before them.
 */
export function analysisWindows(today: string, days: number = DEFAULT_DAYS): Windows {
  const end = addDays(today, -1)
  const current: WindowRange = { from: addDays(end, -(days - 1)), to: end }
  const previous: WindowRange = { from: addDays(current.from, -days), to: addDays(current.from, -1) }
  return { days, current, previous }
}

const inRange = (day: string, r: WindowRange) => day >= r.from && day <= r.to

/** The part of a window that starts on or after `since` (empty when it ends before). */
function clip(range: WindowRange, since: string | null | undefined): WindowRange {
  if (!since || since <= range.from) return range
  return { from: since, to: range.to }
}

const lengthOf = (r: WindowRange) => (r.from > r.to ? 0 : daysBetween(r.from, r.to) + 1)

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

export function emptyMetrics(): Metrics {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    platformConversations: 0,
    conversations: 0,
    leads: 0,
    spendDays: 0,
    costPerConversation: null,
    costPerLead: null,
    leadRate: null,
  }
}

/** Derived figures from the raw sums. */
export function finalizeMetrics(m: Metrics): Metrics {
  return {
    ...m,
    costPerConversation: ratio(m.spend, m.conversations),
    costPerLead: ratio(m.spend, m.leads),
    leadRate: ratio(m.leads, m.conversations),
  }
}

export function sumMetrics(list: Metrics[]): Metrics {
  const total = emptyMetrics()
  for (const m of list) {
    total.spend += m.spend
    total.impressions += m.impressions
    total.clicks += m.clicks
    total.platformConversations += m.platformConversations
    total.conversations += m.conversations
    total.leads += m.leads
    total.spendDays = Math.max(total.spendDays, m.spendDays)
  }
  return finalizeMetrics(total)
}

interface Attributed {
  conversations: number
  leads: number
  headline: string | null
}

/** Chats and leads per ad, and the chats that came with no ad at all. */
function attributedByAd(rows: AttributionInput[]): { byAd: Map<string, Attributed>; direct: number } {
  const byAd = new Map<string, Attributed>()
  let direct = 0
  for (const r of rows) {
    if (r.source_type === 'ad' && r.source_id) {
      const prev = byAd.get(r.source_id)
      byAd.set(r.source_id, {
        conversations: (prev?.conversations ?? 0) + num(r.conversations),
        leads: (prev?.leads ?? 0) + num(r.leads),
        headline: prev?.headline ?? (r.headline?.trim() || null),
      })
    } else if (r.source_type !== 'post') {
      direct += num(r.conversations)
    }
  }
  return { byAd, direct }
}

/**
 * Join the ad catalog, the daily numbers and the attributed chats into one
 * picture of the account for two back-to-back windows. Pure: the same input
 * always gives the same snapshot, which is what lets us replay past dates.
 */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  const windows = analysisWindows(input.today, input.days ?? DEFAULT_DAYS)
  const since = input.attributionSince ?? null
  const ranges = { current: clip(windows.current, since), previous: clip(windows.previous, since) }
  const coverage = {
    attributionSince: since,
    currentDays: lengthOf(ranges.current),
    previousDays: lengthOf(ranges.previous),
    previousComplete: !since || since <= windows.previous.from,
  }
  const catalog = new Map(input.catalog.map((c) => [c.platform_ad_id, c]))
  const att = {
    current: attributedByAd(input.attribution.current),
    previous: attributedByAd(input.attribution.previous),
  }

  const dailyByAd = new Map<string, DailyRowNumbers[]>()
  for (const r of input.daily) {
    const list = dailyByAd.get(r.platform_ad_id) ?? []
    list.push({
      day: r.day,
      spend: num(r.spend),
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      conversations_started: num(r.conversations_started),
    })
    dailyByAd.set(r.platform_ad_id, list)
  }

  const metricsFor = (adId: string, range: WindowRange, which: 'current' | 'previous'): Metrics => {
    const m = emptyMetrics()
    for (const r of dailyByAd.get(adId) ?? []) {
      if (!inRange(r.day, range)) continue
      m.spend += r.spend
      m.impressions += r.impressions
      m.clicks += r.clicks
      m.platformConversations += r.conversations_started
      if (r.spend > 0) m.spendDays += 1
    }
    const a = att[which].byAd.get(adId)
    m.conversations = a?.conversations ?? 0
    m.leads = a?.leads ?? 0
    return finalizeMetrics(m)
  }

  const ids = new Set<string>([
    ...dailyByAd.keys(),
    ...att.current.byAd.keys(),
    ...att.previous.byAd.keys(),
  ])

  const ads: AdSnapshot[] = []
  for (const id of ids) {
    const current = metricsFor(id, ranges.current, 'current')
    const previous = metricsFor(id, ranges.previous, 'previous')
    const active = (m: Metrics) => m.spend > 0 || m.conversations > 0
    if (!active(current) && !active(previous)) continue

    const c = catalog.get(id)
    const spendDays = (dailyByAd.get(id) ?? []).filter((r) => r.spend > 0).map((r) => r.day).sort()
    const firstSpendDay = spendDays[0] ?? null
    ads.push({
      id,
      name: c?.ad_name ?? null,
      headline: att.current.byAd.get(id)?.headline ?? att.previous.byAd.get(id)?.headline ?? null,
      campaignId: c?.campaign_id ?? null,
      campaignName: c?.campaign_name ?? null,
      adSetName: c?.adset_name ?? null,
      status: c?.status ?? null,
      firstSpendDay,
      ageDays: firstSpendDay ? daysBetween(firstSpendDay, windows.current.to) + 1 : null,
      current,
      previous,
    })
  }
  ads.sort((a, b) => b.current.spend - a.current.spend || b.current.conversations - a.current.conversations)

  const byCampaign = new Map<string, AdSnapshot[]>()
  for (const a of ads) {
    const key = a.campaignId ?? 'unknown'
    byCampaign.set(key, [...(byCampaign.get(key) ?? []), a])
  }
  const campaigns: CampaignSnapshot[] = [...byCampaign.entries()].map(([id, list]) => ({
    id,
    name: list.find((a) => a.campaignName)?.campaignName ?? null,
    status: list.some((a) => a.status === 'active') ? 'active' : (list[0].status ?? null),
    adCount: list.length,
    current: sumMetrics(list.map((a) => a.current)),
    previous: sumMetrics(list.map((a) => a.previous)),
  }))
  campaigns.sort((a, b) => b.current.spend - a.current.spend)

  return {
    windows,
    coverage,
    currency: input.catalog.find((c) => c.currency)?.currency ?? 'COP',
    account: {
      current: sumMetrics(ads.map((a) => a.current)),
      previous: sumMetrics(ads.map((a) => a.previous)),
      directConversations: { current: att.current.direct, previous: att.previous.direct },
    },
    campaigns,
    ads,
  }
}

interface DailyRowNumbers {
  day: string
  spend: number
  impressions: number
  clicks: number
  conversations_started: number
}
