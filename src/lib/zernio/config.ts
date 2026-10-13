import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

/** Decrypted Zernio channel config for one account. */
export interface ZernioConfig {
  id: string
  accountId: string
  /** Admin who saved it — sender-of-record for inbound-created rows. */
  userId: string
  apiKey: string
  zernioAccountId: string
  webhookToken: string
  webhookSecret: string
  isActive: boolean
}

interface Row {
  id: string
  account_id: string
  user_id: string
  api_key: string
  zernio_account_id: string
  webhook_token: string
  webhook_secret: string
  is_active: boolean
}

const COLUMNS =
  'id, account_id, user_id, api_key, zernio_account_id, webhook_token, webhook_secret, is_active'

function toConfig(row: Row): ZernioConfig {
  return {
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    apiKey: decrypt(row.api_key),
    zernioAccountId: row.zernio_account_id,
    webhookToken: row.webhook_token,
    webhookSecret: decrypt(row.webhook_secret),
    isActive: row.is_active,
  }
}

/** The account's ACTIVE Zernio config, or null when it uses Meta. */
export async function loadZernioConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<ZernioConfig | null> {
  const { data, error } = await db
    .from('zernio_config')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw error
  return data ? toConfig(data as Row) : null
}

/** Look a config up by the path token of its webhook URL (inbound). */
export async function loadZernioConfigByToken(
  db: SupabaseClient,
  token: string,
): Promise<ZernioConfig | null> {
  const { data, error } = await db
    .from('zernio_config')
    .select(COLUMNS)
    .eq('webhook_token', token)
    .maybeSingle()
  if (error) throw error
  return data ? toConfig(data as Row) : null
}
