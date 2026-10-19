import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

/**
 * The "validate chat data" switch for leads agents send to the CRM by hand.
 *
 *   GET  -> { enabled }
 *   POST { enabled: boolean }
 *
 * On (the default): the form is read-only and a corrected value is only
 * accepted if the customer wrote it in the chat. Off: the agent can type
 * whatever the lead needs. Admins only.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .select('validate_manual_leads')
      .eq('id', accountId)
      .maybeSingle()
    if (error || !data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    return NextResponse.json({ enabled: data.validate_manual_leads !== false })
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
      .update({ validate_manual_leads: body.enabled })
      .eq('id', accountId)
    if (error) {
      console.error('[lead validation] save failed:', error)
      return NextResponse.json({ error: 'Could not save the setting' }, { status: 500 })
    }
    return NextResponse.json({ enabled: body.enabled })
  } catch (err) {
    return toErrorResponse(err)
  }
}
