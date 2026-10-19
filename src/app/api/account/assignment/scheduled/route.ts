import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { countEligible } from '@/lib/conversations/auto-assign'

const MAX_DAYS_AHEAD = 60

/**
 * The one-time scheduled hand-out: at the chosen moment every open or
 * pending conversation that meets the inactivity rule is given, equally,
 * to the available agents (see lib/conversations/auto-assign).
 *
 *   GET  -> { at, result, eligible, agents: [{ user_id, name, available }],
 *             after_minutes, max_age_days }
 *   POST { at: ISO date-time | null }   null cancels the schedule
 *
 * Admins only.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const db = supabaseAdmin()
    const { data, error } = await db
      .from('accounts')
      .select(
        'id, auto_assign_after_minutes, auto_assign_cursor, auto_assign_max_age_days, auto_assign_batch_per_agent, auto_assign_once_at, auto_assign_once_result',
      )
      .eq('id', accountId)
      .maybeSingle()
    if (error || !data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    const [eligible, agentRows] = await Promise.all([
      countEligible(db, data),
      db
        .from('profiles')
        .select('user_id, full_name, available_for_assignment')
        .eq('account_id', accountId)
        .eq('account_role', 'agent')
        .order('created_at', { ascending: true }),
    ])

    const agents = (
      (agentRows.data ?? []) as {
        user_id: string
        full_name: string | null
        available_for_assignment: boolean
      }[]
    ).map((a) => ({
      user_id: a.user_id,
      name: a.full_name,
      available: a.available_for_assignment !== false,
    }))
    return NextResponse.json({
      at: (data.auto_assign_once_at as string | null) ?? null,
      result: data.auto_assign_once_result ?? null,
      eligible,
      agents,
      after_minutes: data.auto_assign_after_minutes as number,
      max_age_days: data.auto_assign_max_age_days as number,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as { at?: unknown }

    let at: string | null = null
    if (body.at !== null) {
      const when = typeof body.at === 'string' ? new Date(body.at) : null
      if (!when || Number.isNaN(when.getTime())) {
        return NextResponse.json({ error: 'Choose a valid date and time', code: 'invalid_time' }, { status: 400 })
      }
      const now = Date.now()
      if (when.getTime() < now - 60_000) {
        return NextResponse.json({ error: 'The time must be in the future', code: 'in_the_past' }, { status: 400 })
      }
      if (when.getTime() > now + MAX_DAYS_AHEAD * 86_400_000) {
        return NextResponse.json({ error: 'Too far ahead', code: 'too_far' }, { status: 400 })
      }
      at = when.toISOString()
    }

    const { error } = await supabaseAdmin()
      .from('accounts')
      // A new schedule starts clean: the previous run's result is no longer news.
      .update({ auto_assign_once_at: at, ...(at ? { auto_assign_once_result: null } : {}) })
      .eq('id', accountId)
    if (error) {
      console.error('[scheduled assign] save failed:', error)
      return NextResponse.json({ error: 'Could not save the schedule' }, { status: 500 })
    }
    return NextResponse.json({ at })
  } catch (err) {
    return toErrorResponse(err)
  }
}
