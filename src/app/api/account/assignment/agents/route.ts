import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

/**
 * Take an agent in or out of the automatic assignment rotation (away, on
 * leave). Admins only.
 *
 *   POST { user_id, available: boolean }
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')

    const body = (await request.json().catch(() => ({}))) as {
      user_id?: unknown
      available?: unknown
    }
    const userId = typeof body.user_id === 'string' ? body.user_id : ''
    if (!userId || typeof body.available !== 'boolean') {
      return NextResponse.json({ error: 'user_id and available are required' }, { status: 400 })
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
