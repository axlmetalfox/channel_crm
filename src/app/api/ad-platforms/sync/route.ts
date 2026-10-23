import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { syncAdAccount } from '@/lib/ad-platforms/sync'

export const maxDuration = 120

/**
 * POST /api/ad-platforms/sync  (admin / owner)
 *
 * Copies the ads and their daily numbers now, instead of waiting for the next
 * scheduled sync (every few hours).
 */
export async function POST() {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ad-sync:${userId}`, { limit: 4, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const result = await syncAdAccount(supabaseAdmin(), accountId)
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error ?? 'sync failed' }, { status: 502 })
    }
    return NextResponse.json({ ok: true, ads: result.ads, rows: result.rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}
