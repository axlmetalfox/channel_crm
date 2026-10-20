interface ContactTagMutationResult {
  added?: boolean;
  dispatched?: boolean;
  reason?: 'duplicate' | 'max_depth';
}

async function mutateContactTag(
  contactId: string,
  tagId: string,
  method: 'POST' | 'DELETE'
): Promise<ContactTagMutationResult> {
  const response = await fetch(`/api/contacts/${contactId}/tags`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_id: tagId }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & ContactTagMutationResult;
  if (!response.ok) {
    throw new Error(body.error ?? 'Failed to update contact tag');
  }
  return body;
}

export function addContactTag(contactId: string, tagId: string) {
  return mutateContactTag(contactId, tagId, 'POST');
}

export function deleteContactTag(contactId: string, tagId: string) {
  return mutateContactTag(contactId, tagId, 'DELETE');
}

export interface BulkContactTagResponse {
  matched: number;
  added: number;
  removed: number;
}

/** Add or remove one tag on several contacts in one call. */
export async function bulkContactTag(
  contactIds: string[],
  tagId: string,
  action: 'add' | 'remove'
): Promise<BulkContactTagResponse> {
  const response = await fetch('/api/contacts/bulk-tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_ids: contactIds, tag_id: tagId, action }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & Partial<BulkContactTagResponse>;
  if (!response.ok) {
    throw new Error(body.error ?? 'Failed to update contact tags');
  }
  return {
    matched: body.matched ?? 0,
    added: body.added ?? 0,
    removed: body.removed ?? 0,
  };
}
