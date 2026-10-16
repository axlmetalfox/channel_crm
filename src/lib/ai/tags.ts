import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Add or remove the account's "office hours" tag on a contact.
 *
 * While the agent is off duty a person answers from another system; the
 * tag makes those conversations easy to find in the inbox. Best-effort:
 * a missing tag (the account never created it) or a failed write is
 * logged at most, never thrown — it must not get in the way of replying.
 */
export async function setOfficeHoursTag(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; tagName: string; on: boolean },
): Promise<void> {
  try {
    const { data: tag } = await db
      .from('tags')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('name', args.tagName)
      .limit(1)
      .maybeSingle()
    const tagId = (tag as { id?: string } | null)?.id
    if (!tagId) return

    if (args.on) {
      await db
        .from('contact_tags')
        .upsert(
          { contact_id: args.contactId, tag_id: tagId },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
        )
    } else {
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', tagId)
    }
  } catch (err) {
    console.error('[ai auto-reply] office-hours tag failed:', err)
  }
}
