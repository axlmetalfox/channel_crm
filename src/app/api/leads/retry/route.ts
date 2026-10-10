import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { retryLeadIntakes } from '@/lib/leads/capture'

/**
 * Re-run lead intakes that did not complete: the extraction call failed,
 * or the CRM endpoint was down or not yet configured when the interview
 * ended. Each intake backs off per attempt and is abandoned after a few
 * tries or three days (see `retryLeadIntakes`).
 *
 * Auth: the shared `AUTOMATION_CRON_SECRET`, same as the other cron
 * routes. Point a scheduler at it every few minutes.
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

  const result = await retryLeadIntakes(supabaseAdmin())
  return NextResponse.json(result)
}
