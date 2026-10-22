import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { secretMatches } from '@/lib/integrations/zoho-advisor'
import { summarizeChannel, type ChannelRow } from '@/lib/zernio/health-report'

/**
 * GET /api/health/whatsapp   (header: x-health-token: <HEALTH_CHECK_TOKEN>)
 *
 * For an external monitor (Uptime Kuma): 200 while the WhatsApp number is
 * connected, 503 when it is disconnected or when the 5-minute watcher has
 * stopped. The body is a single word; it holds no customer data.
 */
export async function GET(request: Request) {
  const expected = process.env.HEALTH_CHECK_TOKEN?.trim()
  if (!expected) {
    return NextResponse.json({ whatsapp: 'not_configured_token' }, { status: 503 })
  }
  if (!secretMatches(request.headers.get('x-health-token'), expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limit = checkRateLimit('health:whatsapp', { limit: 120, windowMs: 60_000 })
  if (!limit.success) return rateLimitResponse(limit)

  const { data, error } = await supabaseAdmin()
    .from('zernio_config')
    .select('connection_status, connection_checked_at')
    .eq('is_active', true)
  if (error) {
    return NextResponse.json({ whatsapp: 'check_failed' }, { status: 503 })
  }

  const { word, http } = summarizeChannel((data ?? []) as ChannelRow[], Date.now())
  return NextResponse.json({ whatsapp: word }, { status: http, headers: { 'Cache-Control': 'no-store' } })
}
