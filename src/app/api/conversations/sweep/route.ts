import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { runAutoAssign, runScheduledAssign } from '@/lib/conversations/auto-assign'
import { runRecoveryNudges } from '@/lib/conversations/recovery'

const DEFAULT_PENDING_MINUTES = 30

/**
 * Housekeeping for conversations, meant for a scheduler every few minutes:
 *   - mark open conversations that have waited on the customer for a while
 *     as Pending (the last message is ours and nobody answered); override
 *     the wait with `CONVERSATION_PENDING_MINUTES`;
 *   - hand stalled conversations to a person, round robin, for accounts
 *     that switched that rule on (Settings > Team);
 *   - run the one-time scheduled hand-out when its time has come;
 *   - send the recovery message to customers who went quiet, for accounts
 *     that wrote one (Agents > Setup).
 *
 * Auth: the shared `AUTOMATION_CRON_SECRET`, same as the other cron routes.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const raw = Number(process.env.CONVERSATION_PENDING_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_PENDING_MINUTES

  const { data, error } = await supabaseAdmin().rpc('mark_pending_conversations', {
    p_minutes: minutes,
  })
  if (error) {
    console.error('[conversations sweep] failed:', error)
    return NextResponse.json({ error: 'sweep failed' }, { status: 500 })
  }
  // A scheduled one-time hand-out goes first, then the recurring rule.
  const scheduled = await runScheduledAssign(supabaseAdmin())
  const { assigned } = await runAutoAssign(supabaseAdmin())
  const { sent } = await runRecoveryNudges(supabaseAdmin())
  return NextResponse.json({
    marked_pending: data ?? 0,
    after_minutes: minutes,
    auto_assigned: assigned,
    scheduled_assigned: scheduled.assigned,
    recovery_sent: sent,
  })
}
