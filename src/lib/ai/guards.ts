import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Small database checks the auto-reply uses to behave well with a real
// customer: not answering every line of a burst, and not answering a
// single contact without end.
// ============================================================

/**
 * True when the customer has written a text message after the given one.
 * The newest message of a burst is the one that gets answered, so the
 * earlier ones step aside.
 */
export async function hasNewerCustomerText(
  db: SupabaseClient,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const { data: mine } = await db
    .from('messages')
    .select('created_at')
    .eq('id', messageId)
    .maybeSingle()
  const since = (mine as { created_at?: string } | null)?.created_at
  if (!since) return false
  const { count } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .eq('content_type', 'text')
    .gt('created_at', since)
  return (count ?? 0) > 0
}

/** Replies the agent sent in this conversation since `sinceIso`. */
export async function aiRepliesSince(
  db: SupabaseClient,
  conversationId: string,
  sinceIso: string,
): Promise<number> {
  const { count } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'bot')
    .eq('ai_generated', true)
    .gte('created_at', sinceIso)
  return count ?? 0
}

/** True when we already sent this exact text in the conversation. */
export async function hasBotMessageWithText(
  db: SupabaseClient,
  conversationId: string,
  text: string,
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'bot')
    .eq('content_text', text)
    .limit(1)
    .maybeSingle()
  return !!data
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
