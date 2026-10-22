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
}

export interface AttributionSummary {
  /** Meta ads and posts, biggest first. */
  sources: AttributionSource[]
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
  }
  return [...groups.values()].sort((a, b) => b.conversations - a.conversations || b.leads - a.leads)
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
  const { data, error } = await db.rpc('attribution_summary', {
    p_from: start.toISOString(),
    p_to: end.toISOString(),
  })
  if (error) throw error
  return summarizeAttribution((data ?? []) as AttributionRow[])
}
