import type { SupabaseClient } from '@supabase/supabase-js';

import { addContactTagAndDispatch } from './tag-events';
import { ContactTagWriteError } from './tag-write';

/** One call never touches more than a page of the contacts list. */
export const MAX_BULK_TAG_CONTACTS = 500;

export interface BulkContactTagInput {
  accountId: string;
  contactIds: string[];
  tagId: string;
  action: 'add' | 'remove';
}

export interface BulkContactTagResult {
  /** Contacts the person can see in this account (the ones that were acted on). */
  matched: number;
  /** Contacts that gained the tag (always 0 for "remove"). */
  added: number;
  /** Contacts that lost the tag (always 0 for "add"). */
  removed: number;
}

/**
 * Add or remove one tag on many contacts. Row-level security scopes the
 * contacts to what the signed-in person can open (an advisor only reaches
 * her own), so ids she cannot see are skipped instead of failing the batch.
 */
export async function bulkSetContactTag(
  db: SupabaseClient,
  input: BulkContactTagInput
): Promise<BulkContactTagResult> {
  const ids = [...new Set(input.contactIds)];

  const { data: tag, error: tagError } = await db
    .from('tags')
    .select('id')
    .eq('id', input.tagId)
    .eq('account_id', input.accountId)
    .maybeSingle();
  if (tagError) throw new ContactTagWriteError('Could not verify tag');
  if (!tag) throw new ContactTagWriteError('Tag not found', 404);

  const { data: visible, error: contactsError } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', input.accountId)
    .in('id', ids);
  if (contactsError) throw new ContactTagWriteError('Could not load contacts');
  const contactIds = (visible ?? []).map((c: { id: string }) => c.id);

  if (input.action === 'remove') {
    if (contactIds.length === 0) return { matched: 0, added: 0, removed: 0 };
    const { data, error } = await db
      .from('contact_tags')
      .delete()
      .eq('tag_id', input.tagId)
      .in('contact_id', contactIds)
      .select('id');
    if (error) {
      throw new ContactTagWriteError(
        `Failed to remove contact tags: ${error.message}`
      );
    }
    return { matched: contactIds.length, added: 0, removed: data?.length ?? 0 };
  }

  let added = 0;
  for (const contactId of contactIds) {
    const result = await addContactTagAndDispatch({
      db,
      accountId: input.accountId,
      contactId,
      tagId: input.tagId,
    });
    if (result.added) added += 1;
  }
  return { matched: contactIds.length, added, removed: 0 };
}
