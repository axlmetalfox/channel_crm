import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/ai/admin-client'

/**
 * Whether an agent takes part in the automatic assignment rotation (away,
 * on leave, busy).
 *
 *   GET  -> { available, eligible }   the caller's own setting
 *   POST { available: boolean, user_id? }
 *
 * Every agent can switch their OWN availability (omit user_id, or send
 * their own). Only admins can change someone else's.
 */
export async function GET() {
  try {
    const { accountId, userId } = await requireRole('agent')
    const { data } = await supabaseAdmin()
      .from('profiles')
      .select('available_for_assignment, account_role')
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .maybeSingle()
    return NextResponse.json({
      available: data?.available_for_assignment !== false,
      // Only people with the agent role are in the rotation.
      eligible: data?.account_role === 'agent',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId: callerId, role } = await requireRole('agent')

    const body = (await request.json().catch(() => ({}))) as {
      user_id?: unknown
      available?: unknown
    }
    const userId = typeof body.user_id === 'string' && body.user_id ? body.user_id : callerId
    if (typeof body.available !== 'boolean') {
      return NextResponse.json({ error: 'available is required' }, { status: 400 })
    }
    if (userId !== callerId && !hasMinRole(role, 'admin')) {
      return NextResponse.json(
        { error: 'You can only change your own availability' },
        { status: 403 },
      )
    }

    // Only agents of this account take part in the rotation.
    const { data, error } = await supabaseAdmin()
      .from('profiles')
      .update({ available_for_assignment: body.available })
      .eq('account_id', accountId)
      .eq('user_id', userId)
      .eq('account_role', 'agent')
      .select('user_id')
    if (error) {
      console.error('[assignment agents] save failed:', error)
      return NextResponse.json({ error: 'Could not save' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }
    return NextResponse.json({ user_id: userId, available: body.available })
  } catch (err) {
    return toErrorResponse(err)
  }
}
