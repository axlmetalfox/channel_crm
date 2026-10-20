import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { isBlockReason, syncWhatsAppBlock } from '@/lib/contacts/block'

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function rpcErrorResponse(error: { message?: string }) {
  const reason = String(error.message ?? '')
  if (reason.includes('not_found')) {
    return NextResponse.json({ error: 'Contact not found', code: 'not_found' }, { status: 404 })
  }
  if (reason.includes('forbidden')) {
    return NextResponse.json({ error: 'Not allowed', code: 'forbidden' }, { status: 403 })
  }
  if (reason.includes('invalid_reason')) {
    return NextResponse.json({ error: 'Invalid reason', code: 'bad_request' }, { status: 400 })
  }
  console.error('[contact block] failed:', error)
  return NextResponse.json({ error: 'Could not update the contact', code: 'failed' }, { status: 500 })
}

/**
 * POST /api/contacts/[id]/block  { reason: 'offensive'|'fake'|'other', note?: string }  (agent+)
 *
 * Blocks the contact inside TUYO (database function `block_contact`, which
 * checks the caller may open the contact) and then on WhatsApp through
 * Zernio. The response says how WhatsApp went: `whatsapp` is one of
 * done | window_expired | failed | no_number | no_channel.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, userId, accountId } = await requireRole('agent')

    const limit = checkRateLimit(`block:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = (await request.json().catch(() => null)) as { reason?: unknown; note?: unknown } | null
    if (!UUID.test(id) || !isBlockReason(body?.reason)) {
      return NextResponse.json({ error: 'reason is required', code: 'bad_request' }, { status: 400 })
    }
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null

    const { error } = await supabase.rpc('block_contact', {
      p_contact_id: id,
      p_reason: body.reason,
      p_note: note,
    })
    if (error) return rpcErrorResponse(error)

    const { data: contact } = await supabase.from('contacts').select('phone').eq('id', id).maybeSingle()
    const whatsapp = await syncWhatsAppBlock(supabaseAdmin(), {
      accountId,
      phone: (contact as { phone?: string | null } | null)?.phone ?? null,
      block: true,
    })

    return NextResponse.json({ ok: true, whatsapp })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/contacts/[id]/block  (admin+): lift the block, here and on WhatsApp. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, userId, accountId } = await requireRole('admin')

    const limit = checkRateLimit(`block:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!UUID.test(id)) {
      return NextResponse.json({ error: 'Invalid contact id', code: 'bad_request' }, { status: 400 })
    }

    const { data: contact } = await supabase.from('contacts').select('phone').eq('id', id).maybeSingle()

    const { error } = await supabase.rpc('unblock_contact', { p_contact_id: id })
    if (error) return rpcErrorResponse(error)

    const whatsapp = await syncWhatsAppBlock(supabaseAdmin(), {
      accountId,
      phone: (contact as { phone?: string | null } | null)?.phone ?? null,
      block: false,
    })

    return NextResponse.json({ ok: true, whatsapp })
  } catch (err) {
    return toErrorResponse(err)
  }
}
