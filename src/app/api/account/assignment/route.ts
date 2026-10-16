import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

const MIN_MINUTES = 5
const MAX_MINUTES = 43_200 // 30 days

/**
 * The account's "assign a conversation to a person after inactivity"
 * rule (applied by the cron sweep, round robin among the agents).
 *
 *   GET  -> { enabled, after_minutes }
 *   POST { enabled: boolean, value: number, unit: 'minutes' | 'hours' }
 *
 * Admins only: it decides who owns the team's conversations.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .select('auto_assign_enabled, auto_assign_after_minutes')
      .eq('id', accountId)
      .maybeSingle()
    if (error || !data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    return NextResponse.json({
      enabled: data.auto_assign_enabled === true,
      after_minutes: data.auto_assign_after_minutes as number,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')

    const body = (await request.json().catch(() => ({}))) as {
      enabled?: unknown
      value?: unknown
      unit?: unknown
    }
    const enabled = body.enabled === true
    const value = Number(body.value)
    const unit = body.unit === 'hours' ? 'hours' : body.unit === 'minutes' ? 'minutes' : null
    if (!unit || !Number.isInteger(value) || value < 1) {
      return NextResponse.json(
        { error: 'Enter a whole number and choose minutes or hours' },
        { status: 400 },
      )
    }
    const minutes = unit === 'hours' ? value * 60 : value
    if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      return NextResponse.json(
        { error: `The wait must be between ${MIN_MINUTES} minutes and 30 days` },
        { status: 400 },
      )
    }

    const { error } = await supabaseAdmin()
      .from('accounts')
      .update({ auto_assign_enabled: enabled, auto_assign_after_minutes: minutes })
      .eq('id', accountId)
    if (error) {
      console.error('[assignment rule] save failed:', error)
      return NextResponse.json({ error: 'Could not save the rule' }, { status: 500 })
    }
    return NextResponse.json({ enabled, after_minutes: minutes })
  } catch (err) {
    return toErrorResponse(err)
  }
}
