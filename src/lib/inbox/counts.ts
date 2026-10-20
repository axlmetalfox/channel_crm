import type { SupabaseClient } from '@supabase/supabase-js'

export interface InboxCounts {
  /** Open conversations: the customer wrote and the company has not answered yet. */
  open: number
  /** Pending conversations: the company answered last and the customer has not replied. */
  pending: number
}

/**
 * The two numbers shown next to the inbox title. Row-level security scopes
 * them to what the signed-in person can open: an advisor counts her own
 * conversations, an admin or the owner counts the whole account.
 */
export async function loadInboxCounts(db: SupabaseClient): Promise<InboxCounts> {
  const count = async (status: 'open' | 'pending') => {
    const { count: n, error } = await db
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', status)
    if (error) throw error
    return n ?? 0
  }
  const [open, pending] = await Promise.all([count('open'), count('pending')])
  return { open, pending }
}
