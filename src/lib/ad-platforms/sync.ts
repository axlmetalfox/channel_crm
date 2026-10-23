import type { SupabaseClient } from '@supabase/supabase-js'
import { loadZernioConfig } from '@/lib/zernio/config'
import {
  listZernioAdAccounts,
  listZernioAdDays,
  listZernioAds,
  listZernioConnections,
} from '@/lib/zernio/client'
import { PROVIDERS, stateFromConnections } from './providers'

// ============================================================
// Copies the connected ad account into TUYO: the name of every ad's campaign
// and ad set (ad_catalog) and what each ad spent per day (ad_insights_daily),
// so the Attribution card can show campaigns and cost per lead.
// ============================================================

const SYNC_EVERY_HOURS = 6
const RETRY_AFTER_FAILURE_MINUTES = 30
const FIRST_SYNC_DAYS = 90
const REFRESH_DAYS = 35
const CHUNK = 500

export interface AdSyncState {
  last_synced_at: string | null
  last_attempt_at: string | null
}

/** A sync is due every few hours, and a failed one is retried after a short wait. */
export function isSyncDue(state: AdSyncState | null, now: Date = new Date()): boolean {
  if (!state) return true
  const attempt = state.last_attempt_at ? new Date(state.last_attempt_at).getTime() : 0
  const synced = state.last_synced_at ? new Date(state.last_synced_at).getTime() : 0
  // The last attempt failed (it is newer than the last success): short retry.
  if (attempt > synced) return now.getTime() - attempt >= RETRY_AFTER_FAILURE_MINUTES * 60_000
  return now.getTime() - synced >= SYNC_EVERY_HOURS * 3_600_000
}

/** YYYY-MM-DD of a date in Bogotá time (the ad account's day). */
export function bogotaDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(date)
}

export function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 86_400_000)
}

export interface AdSyncResult {
  ok: boolean
  ads: number
  rows: number
  error?: string
}

/** Sync one account. Never throws: the outcome is recorded in ad_sync_state. */
export async function syncAdAccount(db: SupabaseClient, accountId: string): Promise<AdSyncResult> {
  const now = new Date()
  const record = async (patch: Record<string, unknown>) => {
    await db.from('ad_sync_state').upsert({ account_id: accountId, ...patch }, { onConflict: 'account_id' })
  }
  try {
    const config = await loadZernioConfig(db, accountId)
    if (!config) return { ok: false, ads: 0, rows: 0, error: 'not_configured' }

    const meta = PROVIDERS.find((p) => p.id === 'meta')!
    const connections = await listZernioConnections(config.apiKey)
    const { state, connection } = stateFromConnections(meta, connections)
    if (!connection || state === 'not_connected') {
      await record({ last_attempt_at: now.toISOString(), last_error: 'not_connected' })
      return { ok: false, ads: 0, rows: 0, error: 'not_connected' }
    }

    const { data: prev } = await db
      .from('ad_sync_state')
      .select('last_synced_at')
      .eq('account_id', accountId)
      .maybeSingle()
    const days = prev?.last_synced_at ? REFRESH_DAYS : FIRST_SYNC_DAYS
    const from = bogotaDay(daysBefore(now, days))
    const to = bogotaDay(now)

    const ads = await listZernioAds({ apiKey: config.apiKey, accountId: connection.id })
    const adAccounts = (await listZernioAdAccounts({ apiKey: config.apiKey, accountId: connection.id })).filter(
      (a) => a.selectable && a.selected,
    )
    const dayRows = []
    for (const adAccount of adAccounts) {
      dayRows.push(
        ...(await listZernioAdDays({
          apiKey: config.apiKey,
          accountId: connection.id,
          adAccountId: adAccount.id,
          from,
          to,
        })),
      )
    }

    const catalog = ads.map((a) => ({
      account_id: accountId,
      platform_ad_id: a.platformAdId,
      ad_name: a.name,
      campaign_id: a.campaignId,
      campaign_name: a.campaignName,
      adset_id: a.adSetId,
      adset_name: a.adSetName,
      status: a.status,
      currency: a.currency,
      synced_at: now.toISOString(),
    }))
    for (let i = 0; i < catalog.length; i += CHUNK) {
      const { error } = await db
        .from('ad_catalog')
        .upsert(catalog.slice(i, i + CHUNK), { onConflict: 'account_id,platform_ad_id' })
      if (error) throw error
    }

    const daily = dayRows.map((r) => ({
      account_id: accountId,
      platform_ad_id: r.platformAdId,
      day: r.day,
      spend: r.spend,
      impressions: r.impressions,
      clicks: r.clicks,
      conversations_started: r.conversationsStarted,
    }))
    for (let i = 0; i < daily.length; i += CHUNK) {
      const { error } = await db
        .from('ad_insights_daily')
        .upsert(daily.slice(i, i + CHUNK), { onConflict: 'account_id,platform_ad_id,day' })
      if (error) throw error
    }

    await record({
      last_synced_at: now.toISOString(),
      last_attempt_at: now.toISOString(),
      last_error: null,
      ads_count: catalog.length,
      rows_count: daily.length,
    })
    return { ok: true, ads: catalog.length, rows: daily.length }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : 'sync failed'
    console.error(`[ad sync] account ${accountId} failed:`, message)
    try {
      await record({ last_attempt_at: now.toISOString(), last_error: message })
    } catch {
      // nothing more to do
    }
    return { ok: false, ads: 0, rows: 0, error: message }
  }
}

/** Part of the 5-minute sweep: sync the accounts that are due. Never throws. */
export async function runAdSyncIfDue(db: SupabaseClient): Promise<{ synced: number }> {
  let synced = 0
  try {
    const { data: rows } = await db.from('zernio_config').select('account_id').eq('is_active', true)
    for (const row of (rows ?? []) as { account_id: string }[]) {
      const { data: state } = await db
        .from('ad_sync_state')
        .select('last_synced_at, last_attempt_at')
        .eq('account_id', row.account_id)
        .maybeSingle()
      if (!isSyncDue(state as AdSyncState | null)) continue
      const result = await syncAdAccount(db, row.account_id)
      // An account with no ad platform connected is not an error worth retrying every 30 minutes.
      if (result.ok) synced += 1
    }
  } catch (err) {
    console.error('[ad sync] sweep failed:', err)
  }
  return { synced }
}
