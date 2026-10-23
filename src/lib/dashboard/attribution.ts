import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// "Fuentes de Atribución": where the conversations come from.
//
// Today the only source TUYO knows is Meta's click-to-WhatsApp referral: an
// ad (source_type 'ad') or a post (organic or boosted, 'post'), identified by
// the ad / post id and described by its headline. Meta does NOT put the
// campaign or ad set name in the click, so what is shown per source is the ad
// itself. Conversations with no referral are "direct".
// ============================================================

export type SourceKind = 'ad' | 'post' | 'direct'

/** One row of the SQL function attribution_summary(). */
export interface AttributionRow {
  source_type: string
  source_id: string | null
  headline: string | null
  media_type: string | null
  source_url: string | null
  conversations: number
  leads: number
}

export interface AttributionSource {
  /** Stable key: the ad / post id, or the headline when grouped by creative. */
  key: string
  kind: SourceKind
  /** Ad / post ids behind this card (several when grouped by headline). */
  sourceIds: string[]
  headline: string | null
  mediaType: string | null
  url: string | null
  conversations: number
  /** Conversations that ended with a lead delivered to the CRM. */
  leads: number
  /** leads / conversations (0 when there are none). */
  rate: number
  /** What the ad cost in the range, once the ad account is connected and synced. */
  spend: number | null
  campaignName: string | null
  adSetName: string | null
  /** Delivery status reported by the ad platform (active, paused...). */
  adStatus: string | null
}

/** One row of the SQL function ad_performance_summary(). */
export interface AdPerformanceRow {
  platform_ad_id: string
  ad_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  adset_name: string | null
  status: string | null
  currency: string | null
  spend: number | string
  impressions: number | string
  clicks: number | string
  meta_conversations: number | string
}

export type CampaignKind = 'campaign' | 'unknown' | 'organic'

/** An ad campaign with the chats it brought and what it cost. */
export interface CampaignSummary {
  key: string
  kind: CampaignKind
  name: string | null
  /** Ads of the campaign that spent or brought chats in the range. */
  ads: number
  conversations: number
  leads: number
  rate: number
  spend: number
  /** Conversations the ad platform says it started (its own count). */
  platformConversations: number
  costPerConversation: number | null
  costPerLead: number | null
  status: string | null
}

export interface PerformanceSummary {
  spend: number
  /** ISO currency of the ad account (COP). */
  currency: string
  /** spend / conversations that came from ads. */
  costPerConversation: number | null
  /** spend / leads sent from ad conversations. */
  costPerLead: number | null
  campaigns: CampaignSummary[]
  /** Spend of ads that brought no conversation in the range. */
  idleSpend: number
}

export interface AttributionSummary {
  /** Meta ads and posts, biggest first. */
  sources: AttributionSource[]
  /** Ad spend and campaigns; null while the ad account is not synced. */
  performance?: PerformanceSummary | null
  /** Conversations with no referral. */
  direct: AttributionSource | null
  attributed: { conversations: number; leads: number; rate: number }
  total: { conversations: number; leads: number; rate: number }
}

function kindOf(type: string): SourceKind {
  return type === 'ad' || type === 'post' ? type : 'direct'
}

function rateOf(leads: number, conversations: number): number {
  return conversations > 0 ? leads / conversations : 0
}

/** One card per ad / post id. */
export function summarizeAttribution(rows: AttributionRow[]): AttributionSummary {
  const sources: AttributionSource[] = []
  const directRows: AttributionSource[] = []
  for (const r of rows) {
    const conversations = Number(r.conversations)
    const leads = Number(r.leads)
    const kind = kindOf(r.source_type)
    const source: AttributionSource = {
      key: r.source_id ?? `${kind}:${r.headline ?? ''}`,
      kind,
      sourceIds: r.source_id ? [r.source_id] : [],
      headline: r.headline?.trim() || null,
      mediaType: r.media_type,
      url: r.source_url && /^https?:\/\//i.test(r.source_url) ? r.source_url : null,
      conversations,
      leads,
      rate: rateOf(leads, conversations),
      spend: null,
      campaignName: null,
      adSetName: null,
      adStatus: null,
    }
    if (kind === 'direct') directRows.push(source)
    else sources.push(source)
  }
  // Several "direct" rows can exist (no id): merge them into one.
  const direct: AttributionSource | null =
    directRows.length === 0
      ? null
      : directRows.reduce((acc, d) => {
          const conversations = acc.conversations + d.conversations
          const leads = acc.leads + d.leads
          return { ...acc, conversations, leads, rate: rateOf(leads, conversations) }
        }, { ...directRows[0], key: 'direct', conversations: 0, leads: 0, rate: 0 })
  sources.sort((a, b) => b.conversations - a.conversations || b.leads - a.leads)

  const attributedConversations = sources.reduce((n, s) => n + s.conversations, 0)
  const attributedLeads = sources.reduce((n, s) => n + s.leads, 0)
  const totalConversations = attributedConversations + (direct?.conversations ?? 0)
  const totalLeads = attributedLeads + (direct?.leads ?? 0)
  return {
    sources,
    direct,
    attributed: {
      conversations: attributedConversations,
      leads: attributedLeads,
      rate: rateOf(attributedLeads, attributedConversations),
    },
    total: { conversations: totalConversations, leads: totalLeads, rate: rateOf(totalLeads, totalConversations) },
  }
}

/**
 * The same ad is often run in several ad sets with the same text: group the
 * sources that share kind, headline and media into one "creative".
 */
export function groupByCreative(sources: AttributionSource[]): AttributionSource[] {
  const groups = new Map<string, AttributionSource>()
  for (const s of sources) {
    // Without a headline there is nothing to group by: keep it on its own.
    const key = s.headline ? `${s.kind}|${s.headline.toLowerCase()}|${s.mediaType ?? ''}` : s.key
    const g = groups.get(key)
    if (!g) {
      groups.set(key, { ...s, key })
      continue
    }
    g.sourceIds = [...g.sourceIds, ...s.sourceIds]
    g.conversations += s.conversations
    g.leads += s.leads
    g.rate = rateOf(g.leads, g.conversations)
    g.url = g.url ?? s.url
    g.spend = g.spend === null && s.spend === null ? null : (g.spend ?? 0) + (s.spend ?? 0)
    if (g.campaignName !== s.campaignName) g.campaignName = null
    if (g.adSetName !== s.adSetName) g.adSetName = null
  }
  return [...groups.values()].sort((a, b) => b.conversations - a.conversations || b.leads - a.leads)
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

/**
 * Add what the ads cost to the attribution: the campaign and ad set of every
 * ad, its spend, and a per-campaign roll-up with cost per conversation and per
 * lead. `perf` is empty until the ad account is connected and synced, and then
 * the summary is returned untouched.
 */
export function withAdPerformance(summary: AttributionSummary, perf: AdPerformanceRow[]): AttributionSummary {
  if (perf.length === 0) return { ...summary, performance: null }

  const byId = new Map(perf.map((p) => [p.platform_ad_id, p]))
  const sources = summary.sources.map((s) => {
    const row = s.sourceIds.length === 1 ? byId.get(s.sourceIds[0]) : undefined
    if (!row) return s
    return {
      ...s,
      spend: Number(row.spend),
      campaignName: row.campaign_name,
      adSetName: row.adset_name,
      adStatus: row.status,
    }
  })

  interface Bucket extends CampaignSummary {
    adIds: Set<string>
  }
  const buckets = new Map<string, Bucket>()
  const bucket = (key: string, kind: CampaignKind, name: string | null): Bucket => {
    let b = buckets.get(key)
    if (!b) {
      b = {
        key, kind, name, ads: 0, conversations: 0, leads: 0, rate: 0, spend: 0,
        platformConversations: 0, costPerConversation: null, costPerLead: null, status: null,
        adIds: new Set(),
      }
      buckets.set(key, b)
    }
    return b
  }

  const chatIds = new Set<string>()
  for (const s of sources) {
    if (s.kind === 'ad' || s.kind === 'post') for (const id of s.sourceIds) chatIds.add(id)
  }
  // Ads of the account: the campaign collects their spend and the platform's own count.
  for (const row of perf) {
    const spend = Number(row.spend)
    const hasChats = chatIds.has(row.platform_ad_id)
    if (spend <= 0 && !hasChats) continue
    const b = row.campaign_id
      ? bucket(row.campaign_id, 'campaign', row.campaign_name)
      : bucket('unknown', 'unknown', null)
    b.spend += spend
    b.platformConversations += Number(row.meta_conversations)
    b.adIds.add(row.platform_ad_id)
    // A campaign is active when any of its ads is.
    if (b.status !== 'active') b.status = row.status ?? b.status
  }
  // Chats go to the campaign of their ad; posts and unknown ads have their own groups.
  for (const s of sources) {
    if (s.kind === 'direct') continue
    const row = s.sourceIds.length === 1 ? byId.get(s.sourceIds[0]) : undefined
    const b =
      s.kind === 'post'
        ? bucket('organic', 'organic', null)
        : row?.campaign_id
          ? bucket(row.campaign_id, 'campaign', row.campaign_name)
          : bucket('unknown', 'unknown', null)
    b.conversations += s.conversations
    b.leads += s.leads
    for (const id of s.sourceIds) b.adIds.add(id)
  }

  const campaigns = [...buckets.values()].map(({ adIds, ...c }) => ({
    ...c,
    ads: adIds.size,
    rate: rateOf(c.leads, c.conversations),
    costPerConversation: ratio(c.spend, c.conversations),
    costPerLead: ratio(c.spend, c.leads),
  }))
  campaigns.sort((a, b) => b.spend - a.spend || b.conversations - a.conversations)

  const adSources = sources.filter((s) => s.kind === 'ad')
  const adConversations = adSources.reduce((n, s) => n + s.conversations, 0)
  const adLeads = adSources.reduce((n, s) => n + s.leads, 0)
  const spend = perf.reduce((n, p) => n + Number(p.spend), 0)
  const idleSpend = perf
    .filter((p) => !chatIds.has(p.platform_ad_id))
    .reduce((n, p) => n + Number(p.spend), 0)

  return {
    ...summary,
    sources,
    performance: {
      spend,
      currency: perf.find((p) => p.currency)?.currency ?? 'COP',
      costPerConversation: ratio(spend, adConversations),
      costPerLead: ratio(spend, adLeads),
      campaigns,
      idleSpend,
    },
  }
}

/** The ads of the connected ad account with what they spent in the range. Empty when not synced. */
export async function loadAdPerformance(db: SupabaseClient, from: string, to: string): Promise<AdPerformanceRow[]> {
  const { data, error } = await db.rpc('ad_performance_summary', { p_from: from, p_to: to })
  if (error) {
    console.warn('[dashboard] ad performance unavailable:', error.message)
    return []
  }
  return (data ?? []) as AdPerformanceRow[]
}

/**
 * Load the summary for `from`..`to` (inclusive local days, YYYY-MM-DD), by the
 * date each conversation was created. Row-level security scopes it to what the
 * signed-in person may open.
 */
export async function loadAttributionSummary(
  db: SupabaseClient,
  from: string,
  to: string,
): Promise<AttributionSummary> {
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  end.setDate(end.getDate() + 1)
  const [{ data, error }, perf] = await Promise.all([
    db.rpc('attribution_summary', { p_from: start.toISOString(), p_to: end.toISOString() }),
    loadAdPerformance(db, from, to),
  ])
  if (error) throw error
  return withAdPerformance(summarizeAttribution((data ?? []) as AttributionRow[]), perf)
}
