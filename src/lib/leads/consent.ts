import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Consent by notice.
//
// When the account sends a data-processing notice as the first message
// of a conversation (ai_configs.consent_notice), continuing the chat after
// it is the acceptance. A lead from a conversation that contains the notice
// followed by a message from the customer therefore counts as authorized,
// with no need for the customer to say "yes".
// ============================================================

export interface NoticeConsent {
  given: boolean
  /** When the customer carried on after the notice (the acceptance). */
  at: string | null
}

/**
 * Whether the conversation contains `notice` sent by us and a customer
 * message after it. `notice` null/empty means the account has none.
 */
export async function consentFromNotice(
  db: SupabaseClient,
  conversationId: string,
  notice: string | null,
): Promise<NoticeConsent> {
  const text = notice?.trim()
  if (!text) return { given: false, at: null }

  const { data: sent } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'bot')
    .eq('content_text', text)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const noticeAt = (sent as { created_at?: string } | null)?.created_at
  if (!noticeAt) return { given: false, at: null }

  const { data: reply } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .gt('created_at', noticeAt)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const at = (reply as { created_at?: string } | null)?.created_at
  return at ? { given: true, at } : { given: false, at: null }
}
