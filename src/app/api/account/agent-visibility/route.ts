import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

/**
 * Whether agents can open every conversation or only the ones assigned to
 * them (accounts.agents_see_only_assigned, enforced by row-level security).
 * Admins, the owner and viewers always see everything.
 *
 *   GET  -> { enabled }
 *   POST { enabled: boolean }
 *
 * Admins only.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .select('agents_see_only_assigned')
      .eq('id', accountId)
      .maybeSingle()
    if (error || !data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    return NextResponse.json({ enabled: data.agents_see_only_assigned === true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 })
    }
    const { error } = await supabaseAdmin()
      .from('accounts')
      .update({ agents_see_only_assigned: body.enabled })
      .eq('id', accountId)
    if (error) {
      console.error('[agent visibility] save failed:', error)
      return NextResponse.json({ error: 'Could not save the setting' }, { status: 500 })
    }
    return NextResponse.json({ enabled: body.enabled })
  } catch (err) {
    return toErrorResponse(err)
  }
}
