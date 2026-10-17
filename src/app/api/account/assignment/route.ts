import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

const MIN_MINUTES = 5
const MAX_MINUTES = 43_200 // 30 days
const MAX_AGE_DAYS = 90
const MAX_BATCH = 50

/**
 * The account's "assign a conversation to a person after inactivity"
 * rule (applied by the cron sweep, round robin among the agents).
 *
 *   GET  -> { enabled, after_minutes, max_age_days, batch_per_agent,
 *             agents: [{ user_id, name, available }] }
 *   POST { enabled, value, unit: 'minutes' | 'hours',
 *          max_age_days?, batch_per_agent? }
 *
 * Admins only: it decides who owns the team's conversations. Whether an
 * agent takes part in the rotation is set through
 * /api/account/assignment/agents.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const db = supabaseAdmin()
    const { data, error } = await db
      .from('accounts')
      .select(
        'auto_assign_enabled, auto_assign_after_minutes, auto_assign_max_age_days, auto_assign_batch_per_agent',
      )
      .eq('id', accountId)
      .maybeSingle()
    if (error || !data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

    const { data: agentRows } = await db
      .from('profiles')
      .select('user_id, full_name, available_for_assignment')
      .eq('account_id', accountId)
      .eq('account_role', 'agent')
      .order('created_at', { ascending: true })

    return NextResponse.json({
      enabled: data.auto_assign_enabled === true,
      after_minutes: data.auto_assign_after_minutes as number,
      max_age_days: data.auto_assign_max_age_days as number,
      batch_per_agent: data.auto_assign_batch_per_agent as number,
      agents: ((agentRows ?? []) as {
        user_id: string
        full_name: string | null
        available_for_assignment: boolean | null
      }[]).map((a) => ({
        user_id: a.user_id,
        name: a.full_name,
        available: a.available_for_assignment !== false,
      })),
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
      max_age_days?: unknown
      batch_per_agent?: unknown
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

    const update: Record<string, unknown> = {
      auto_assign_enabled: enabled,
      auto_assign_after_minutes: minutes,
    }
    if (body.max_age_days !== undefined) {
      const days = Number(body.max_age_days)
      if (!Number.isInteger(days) || days < 1 || days > MAX_AGE_DAYS) {
        return NextResponse.json(
          { error: `The age limit must be between 1 and ${MAX_AGE_DAYS} days` },
          { status: 400 },
        )
      }
      update.auto_assign_max_age_days = days
    }
    if (body.batch_per_agent !== undefined) {
      const batch = Number(body.batch_per_agent)
      if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) {
        return NextResponse.json(
          { error: `The batch per agent must be between 1 and ${MAX_BATCH}` },
          { status: 400 },
        )
      }
      update.auto_assign_batch_per_agent = batch
    }

    const { error } = await supabaseAdmin().from('accounts').update(update).eq('id', accountId)
    if (error) {
      console.error('[assignment rule] save failed:', error)
      return NextResponse.json({ error: 'Could not save the rule' }, { status: 500 })
    }
    return NextResponse.json({
      enabled,
      after_minutes: minutes,
      max_age_days: update.auto_assign_max_age_days ?? null,
      batch_per_agent: update.auto_assign_batch_per_agent ?? null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
