import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The stage a quick reply moves the chat to, checked against the account:
 * a uuid of one of its stages, null for "none", or undefined when the value
 * is not acceptable (another account's stage, wrong type).
 */
export async function resolveQuickReplyStage(
  db: SupabaseClient,
  accountId: string,
  raw: unknown,
): Promise<string | null | undefined> {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'string') return undefined
  const { data } = await db
    .from('conversation_stages')
    .select('id')
    .eq('id', raw)
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? undefined
}
