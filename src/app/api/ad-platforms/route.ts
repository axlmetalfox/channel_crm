import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadZernioConfig } from '@/lib/zernio/config'
import { countZernioAds, listZernioAdAccounts, listZernioConnections } from '@/lib/zernio/client'
import { PROVIDERS, stateFromConnections, type ProviderStatus } from '@/lib/ad-platforms/providers'

/**
 * GET /api/ad-platforms  (admin / owner)
 *
 * The state of every ad platform the account can connect, read live from the
 * connection service: connected, needs a new sign-in, not connected, or coming
 * soon, plus (when connected) the ad accounts and how many ads were synced.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const config = await loadZernioConfig(supabaseAdmin(), accountId)
    if (!config) {
      return NextResponse.json({
        available: false,
        providers: PROVIDERS.map((p) => ({ id: p.id, state: p.available ? 'not_connected' : 'coming_soon', connection: null })),
      })
    }

    let connections: Awaited<ReturnType<typeof listZernioConnections>> = []
    try {
      connections = await listZernioConnections(config.apiKey)
    } catch (err) {
      console.error('[ad-platforms] could not list the connections:', err)
      return NextResponse.json({ error: 'Could not read the connections' }, { status: 502 })
    }

    const admin = supabaseAdmin()
    const { data: syncRow } = await admin
      .from('ad_sync_state')
      .select('last_synced_at, last_error')
      .eq('account_id', accountId)
      .maybeSingle()
    const sync = syncRow
      ? { lastSyncedAt: syncRow.last_synced_at as string | null, lastError: syncRow.last_error as string | null }
      : null

    const providers: ProviderStatus[] = []
    for (const def of PROVIDERS) {
      const { state, connection } = stateFromConnections(def, connections)
      if (!connection) {
        providers.push({ id: def.id, state, connection: null })
        continue
      }
      let adAccounts: Awaited<ReturnType<typeof listZernioAdAccounts>> = []
      let adsCount = 0
      try {
        ;[adAccounts, adsCount] = await Promise.all([
          listZernioAdAccounts({ apiKey: config.apiKey, accountId: connection.id }),
          countZernioAds({ apiKey: config.apiKey, accountId: connection.id }),
        ])
      } catch (err) {
        console.warn('[ad-platforms] could not read the ad accounts:', err instanceof Error ? err.message : err)
      }
      providers.push({
        id: def.id,
        state,
        connection: {
          name: connection.displayName ?? connection.username,
          since: connection.createdAt,
          adAccounts,
          adsCount,
          sync: def.id === 'meta' ? sync : null,
        },
      })
    }
    return NextResponse.json({ available: true, providers })
  } catch (err) {
    return toErrorResponse(err)
  }
}
