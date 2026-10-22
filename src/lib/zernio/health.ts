import type { SupabaseClient } from '@supabase/supabase-js'

import { checkZernioAccount, getWhatsAppNumberStatus } from './client'
import { loadZernioConfig } from './config'

// ============================================================
// Is the WhatsApp number still connected?
//
// On 2026-10-21 the number was deregistered from Meta's Cloud API (the Zoho
// integration was deleted) and nobody knew until the next morning: nothing
// came in and every send failed. The sweep now reads the live status of the
// number and keeps it on zernio_config, so the app can show a banner and the
// scheduler can alert.
// ============================================================

export type ChannelStatus = 'connected' | 'disconnected' | 'unknown'

/** What one reading of the number says. `null` status = it could not be read. */
export function observeChannel(
  phoneStatus: string | null | undefined,
  inboundSubscribed: boolean | null | undefined,
): { observed: ChannelStatus; detail: string | null } {
  const status = (phoneStatus ?? '').trim().toUpperCase()
  if (!status) return { observed: 'unknown', detail: null }
  if (status !== 'CONNECTED') return { observed: 'disconnected', detail: status }
  if (inboundSubscribed === false) return { observed: 'disconnected', detail: 'INBOUND_WEBHOOK_NOT_SUBSCRIBED' }
  return { observed: 'connected', detail: status }
}

export interface HealthState {
  status: ChannelStatus
  failCount: number
  downSince: string | null
  alertedAt: string | null
}

export type HealthAlert = 'down' | 'restored' | null

/** Bad readings in a row before the number is declared down. */
export const CONFIRM_AFTER = 2

/**
 * The state after one more reading. A bad reading only counts once it repeats
 * (`CONFIRM_AFTER`); the alert fires once when the outage is confirmed and
 * once when the number is back. An unreadable result changes nothing.
 */
export function nextHealth(
  prev: HealthState,
  observed: ChannelStatus,
  nowIso: string,
): { state: HealthState; alert: HealthAlert } {
  if (observed === 'unknown') return { state: prev, alert: null }

  if (observed === 'connected') {
    const wasDown = prev.status === 'disconnected'
    return {
      state: { status: 'connected', failCount: 0, downSince: null, alertedAt: null },
      alert: wasDown && prev.alertedAt ? 'restored' : null,
    }
  }

  const failCount = prev.failCount + 1
  const downSince = prev.downSince ?? nowIso
  if (failCount < CONFIRM_AFTER) {
    return { state: { ...prev, failCount, downSince }, alert: null }
  }
  const firstAlert = !prev.alertedAt
  return {
    state: { status: 'disconnected', failCount, downSince, alertedAt: prev.alertedAt ?? nowIso },
    alert: firstAlert ? 'down' : null,
  }
}

export interface ChannelHealthResult {
  accounts: number
  alerts: { accountId: string; alert: Exclude<HealthAlert, null> }[]
}

/**
 * Read the live status of every connected number and update its row. Never
 * throws. Runs with the 5-minute sweep: two cheap GETs per account.
 */
export async function runChannelHealthCheck(db: SupabaseClient): Promise<ChannelHealthResult> {
  const result: ChannelHealthResult = { accounts: 0, alerts: [] }
  try {
    const { data: rows } = await db
      .from('zernio_config')
      .select('account_id, connection_status, connection_fail_count, connection_down_since, connection_alerted_at')
      .eq('is_active', true)
    for (const row of (rows ?? []) as {
      account_id: string
      connection_status: ChannelStatus
      connection_fail_count: number
      connection_down_since: string | null
      connection_alerted_at: string | null
    }[]) {
      try {
        const config = await loadZernioConfig(db, row.account_id)
        if (!config) continue

        let phoneStatus: string | null = null
        let inbound: boolean | null = null
        try {
          const [number, health] = await Promise.all([
            getWhatsAppNumberStatus({ apiKey: config.apiKey, accountId: config.zernioAccountId }),
            checkZernioAccount(config.apiKey, config.zernioAccountId).catch(() => null),
          ])
          phoneStatus = number.phoneStatus
          inbound = health?.inboundWebhookSubscribed ?? null
        } catch (err) {
          console.warn(`[channel health] account ${row.account_id}: could not read the number status:`, err instanceof Error ? err.message : err)
        }

        const { observed, detail } = observeChannel(phoneStatus, inbound)
        const nowIso = new Date().toISOString()
        const { state, alert } = nextHealth(
          {
            status: row.connection_status,
            failCount: row.connection_fail_count,
            downSince: row.connection_down_since,
            alertedAt: row.connection_alerted_at,
          },
          observed,
          nowIso,
        )

        await db
          .from('zernio_config')
          .update({
            connection_status: state.status,
            connection_fail_count: state.failCount,
            connection_down_since: state.downSince,
            connection_alerted_at: state.alertedAt,
            connection_checked_at: nowIso,
            ...(observed !== 'unknown' ? { connection_detail: detail } : {}),
          })
          .eq('account_id', row.account_id)

        if (alert) {
          result.alerts.push({ accountId: row.account_id, alert })
          console.error(
            alert === 'down'
              ? `[channel health] WHATSAPP DISCONNECTED for account ${row.account_id} (${detail ?? 'unknown'})`
              : `[channel health] WhatsApp reconnected for account ${row.account_id}`,
          )
        }
        result.accounts += 1
      } catch (err) {
        console.error(`[channel health] account ${row.account_id} failed:`, err)
      }
    }
  } catch (err) {
    console.error('[channel health] check failed:', err)
  }
  return result
}
