import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  MAX_BULK_TAG_CONTACTS,
  bulkSetContactTag,
} from '@/lib/contacts/tag-bulk';
import { ContactTagWriteError } from '@/lib/contacts/tag-write';

/**
 * POST { contact_ids: string[], tag_id: string, action: 'add' | 'remove' }
 * Adds or removes one tag on several contacts at once.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      contact_ids?: unknown;
      tag_id?: unknown;
      action?: unknown;
    } | null;

    const tagId = typeof body?.tag_id === 'string' ? body.tag_id.trim() : '';
    const action = body?.action;
    const contactIds = Array.isArray(body?.contact_ids)
      ? body.contact_ids.filter(
          (id): id is string => typeof id === 'string' && id.length > 0
        )
      : [];

    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 });
    }
    if (action !== 'add' && action !== 'remove') {
      return NextResponse.json(
        { error: 'action must be add or remove' },
        { status: 400 }
      );
    }
    if (contactIds.length === 0) {
      return NextResponse.json(
        { error: 'contact_ids required' },
        { status: 400 }
      );
    }
    if (contactIds.length > MAX_BULK_TAG_CONTACTS) {
      return NextResponse.json(
        { error: `At most ${MAX_BULK_TAG_CONTACTS} contacts per call` },
        { status: 400 }
      );
    }

    const result = await bulkSetContactTag(ctx.supabase, {
      accountId: ctx.accountId,
      contactIds,
      tagId,
      action,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    return toErrorResponse(error);
  }
}
