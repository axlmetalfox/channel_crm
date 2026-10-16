import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { ManualLeadError, submitManualLead } from '@/lib/leads/manual'

/**
 * POST /api/leads/submit  { intake_id, lead: { ...reviewed fields } }
 *
 * Sends the lead an agent reviewed (see /api/leads/prepare) to the CRM,
 * marked "registered from TUYO CRM by <agent>". The consent flag comes
 * from the stored draft, not from this request.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`manual-lead:${userId}`, RATE_LIMITS.manualLead)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as { intake_id?: unknown; lead?: unknown }
    const intakeId = typeof body.intake_id === 'string' ? body.intake_id : ''
    if (!intakeId || !body.lead || typeof body.lead !== 'object') {
      return NextResponse.json({ error: 'intake_id and lead are required' }, { status: 400 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('user_id', userId)
      .maybeSingle()

    const result = await submitManualLead(supabaseAdmin(), {
      accountId,
      intakeId,
      userId,
      userName: (profile?.full_name as string | null | undefined) ?? null,
      edits: body.lead,
    })
    return NextResponse.json({ status: result.status })
  } catch (err) {
    if (err instanceof ManualLeadError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
