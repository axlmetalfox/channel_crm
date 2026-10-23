import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSnapshot, addDays, analysisWindows } from './snapshot'
import type { AttributionInput, CatalogAd, DailyRow, Snapshot } from './types'

/** How far back the daily numbers are read: enough for both windows and for an ad's age. */
const HISTORY_DAYS = 90
const PAGE = 1000

/** The start of a Bogotá day as an instant (Colombia has no daylight saving: always UTC-5). */
const bogotaStart = (day: string) => `${day}T00:00:00-05:00`

async function loadDaily(db: SupabaseClient, from: string, to: string): Promise<DailyRow[]> {
  const rows: DailyRow[] = []
  for (let offset = 0; offset < 200_000; offset += PAGE) {
    const { data, error } = await db
      .from('ad_insights_daily')
      .select('platform_ad_id, day, spend, impressions, clicks, conversations_started')
      .gte('day', from)
      .lte('day', to)
      .order('day', { ascending: true })
      .order('platform_ad_id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    rows.push(...((data ?? []) as DailyRow[]))
    if (!data || data.length < PAGE) break
  }
  return rows
}

async function loadAttribution(db: SupabaseClient, from: string, to: string): Promise<AttributionInput[]> {
  const { data, error } = await db.rpc('attribution_summary', {
    p_from: bogotaStart(from),
    p_to: bogotaStart(addDays(to, 1)),
  })
  if (error) throw error
  return (data ?? []) as AttributionInput[]
}

/** The Bogotá calendar day of an instant. */
function bogotaDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(iso))
}

/** First day a chat was recorded with the ad it came from (null when none yet). */
async function loadAttributionSince(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db
    .from('conversations')
    .select('created_at')
    .not('attribution', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw error
  const first = data?.[0]?.created_at as string | undefined
  return first ? bogotaDay(first) : null
}

/**
 * Read what the analysis needs from the database and build the snapshot for
 * `today` (YYYY-MM-DD, Bogotá). Row-level security scopes it to the signed-in
 * person's account; the server job passes the service client.
 */
export async function loadSnapshot(db: SupabaseClient, today: string, days?: number): Promise<Snapshot> {
  const windows = analysisWindows(today, days)
  const [catalog, daily, current, previous, attributionSince] = await Promise.all([
    db
      .from('ad_catalog')
      .select('platform_ad_id, ad_name, campaign_id, campaign_name, adset_name, status, currency')
      .then(({ data, error }) => {
        if (error) throw error
        return (data ?? []) as CatalogAd[]
      }),
    loadDaily(db, addDays(windows.current.to, -HISTORY_DAYS), windows.current.to),
    loadAttribution(db, windows.current.from, windows.current.to),
    loadAttribution(db, windows.previous.from, windows.previous.to),
    loadAttributionSince(db),
  ])
  return buildSnapshot({ today, days, catalog, daily, attribution: { current, previous }, attributionSince })
}
