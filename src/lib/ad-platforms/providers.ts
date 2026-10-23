import type { ZernioAdAccount, ZernioConnection } from '@/lib/zernio/client'

// ============================================================
// Ad platforms the account can connect.
//
// Each provider is one entry here: adding Google or TikTok later means
// flipping its `available` flag and giving it a connection flow, not a new
// screen. The people using TUYO never see which service carries the
// connection; they press "Conectar" and sign in to the provider.
// ============================================================

export type ProviderId = 'meta' | 'google' | 'tiktok' | 'openai'

export interface ProviderDef {
  id: ProviderId
  /** Whether the connection flow exists today. */
  available: boolean
  /** The connection's platform name on the connection service side. */
  connectionPlatform: string | null
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'meta', available: true, connectionPlatform: 'metaads' },
  { id: 'google', available: false, connectionPlatform: 'googleads' },
  { id: 'tiktok', available: false, connectionPlatform: 'tiktokads' },
  { id: 'openai', available: false, connectionPlatform: null },
]

export type ProviderState = 'connected' | 'needs_reconnect' | 'not_connected' | 'coming_soon'

export interface ProviderSync {
  lastSyncedAt: string | null
  lastError: string | null
}

export interface ProviderConnection {
  name: string | null
  since: string | null
  adAccounts: ZernioAdAccount[]
  adsCount: number
  /** When the ads and their daily numbers were last copied into TUYO. */
  sync: ProviderSync | null
}

export interface ProviderStatus {
  id: ProviderId
  state: ProviderState
  connection: ProviderConnection | null
}

/**
 * The state of a provider from the connections the account has: connected,
 * needing a new sign-in (the provider revoked or expired the access), or not
 * connected at all.
 */
export function stateFromConnections(
  def: ProviderDef,
  connections: ZernioConnection[],
): { state: ProviderState; connection: ZernioConnection | null } {
  if (!def.available || !def.connectionPlatform) return { state: 'coming_soon', connection: null }
  const mine = connections.filter((c) => c.platform === def.connectionPlatform && c.enabled)
  if (mine.length === 0) return { state: 'not_connected', connection: null }
  // A healthy one wins over a broken one when there are several.
  const healthy = mine.find((c) => c.isActive && !c.needsReconnection)
  if (healthy) return { state: 'connected', connection: healthy }
  return { state: 'needs_reconnect', connection: mine[0] }
}

/** The profile new connections belong to: the one the existing connections already use. */
export function profileForNewConnection(connections: ZernioConnection[]): string | null {
  return connections.find((c) => c.profileId)?.profileId ?? null
}
