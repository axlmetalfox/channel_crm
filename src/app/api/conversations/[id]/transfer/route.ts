import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/conversations/[id]/transfer  { to_user_id: uuid | null }  (agent+)
 *
 * Hand a conversation to a colleague, or release it (`null` = unassigned).
 * An agent can only transfer a conversation that is hers; admins and the
 * owner can move any. The new owner must be an agent, admin or owner of the
 * account. The checks live in the database function `transfer_conversation`
 * (migration 064), which runs as the caller so the "assigned to you"
 * notification and the assignment log name who handed it over.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireRole('agent')

    const limit = checkRateLimit(`transfer:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = (await request.json().catch(() => null)) as { to_user_id?: unknown } | null
    const to = body?.to_user_id
    if (!UUID.test(id) || !body || !('to_user_id' in body) || !(to === null || (typeof to === 'string' && UUID.test(to)))) {
      return NextResponse.json(
        { error: 'to_user_id must be a user id or null', code: 'bad_request' },
        { status: 400 },
      )
    }

    const { error } = await supabase.rpc('transfer_conversation', {
      p_conversation_id: id,
      p_to_user_id: to,
    })
    if (error) {
      const reason = String(error.message ?? '')
      if (reason.includes('not_found')) {
        return NextResponse.json({ error: 'Conversation not found', code: 'not_found' }, { status: 404 })
      }
      if (reason.includes('not_owner')) {
        return NextResponse.json(
          { error: 'Only the person who owns this conversation can transfer it', code: 'not_owner' },
          { status: 403 },
        )
      }
      if (reason.includes('forbidden')) {
        return NextResponse.json({ error: 'Not allowed', code: 'forbidden' }, { status: 403 })
      }
      if (reason.includes('invalid_target')) {
        return NextResponse.json(
          { error: 'That person cannot receive conversations', code: 'invalid_target' },
          { status: 400 },
        )
      }
      console.error('[transfer] failed:', error)
      return NextResponse.json({ error: 'Could not transfer the conversation', code: 'failed' }, { status: 500 })
    }

    return NextResponse.json({ assigned_agent_id: to })
  } catch (err) {
    return toErrorResponse(err)
  }
}
