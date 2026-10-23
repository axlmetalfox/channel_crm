import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadZernioConfig } from '@/lib/zernio/config'
import { listZernioConnections, startMetaAdsConnect, ZernioError } from '@/lib/zernio/client'
import { profileForNewConnection } from '@/lib/ad-platforms/providers'

/** The public address of this deployment: where the sign-in returns to. */
function siteOrigin(request: Request): string | null {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  const candidates = [
    explicit,
    request.headers.get('x-forwarded-host')
      ? `https://${request.headers.get('x-forwarded-host')}`
      : null,
  ]
  for (const raw of candidates) {
    if (!raw) continue
    try {
      const url = new URL(raw)
      if (url.protocol === 'https:') return url.origin
    } catch {
      // try the next one
    }
  }
  return null
}

/**
 * POST /api/ad-platforms/meta/connect  (admin / owner)
 *
 * Starts (or renews) the Meta connection: returns the address where the person
 * signs in to Meta and approves access. When she finishes, the browser comes
 * back to /ad-platforms and the page picks the connection up by itself.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ad-connect:${userId}`, { limit: 10, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const origin = siteOrigin(request)
    if (!origin) {
      return NextResponse.json({ error: 'The site address is not configured', code: 'no_site_url' }, { status: 503 })
    }

    const config = await loadZernioConfig(supabaseAdmin(), accountId)
    if (!config) {
      return NextResponse.json({ error: 'The connection service is not set up', code: 'not_configured' }, { status: 400 })
    }

    const profileId = profileForNewConnection(await listZernioConnections(config.apiKey))
    if (!profileId) {
      return NextResponse.json({ error: 'No profile to connect to', code: 'no_profile' }, { status: 400 })
    }

    const { authUrl } = await startMetaAdsConnect({
      apiKey: config.apiKey,
      profileId,
      redirectUrl: `${origin}/ad-platforms?provider=meta&returned=1`,
    })
    return NextResponse.json({ authUrl })
  } catch (err) {
    if (err instanceof ZernioError) {
      console.error('[ad-platforms] connect failed:', err.status, err.message)
      return NextResponse.json({ error: 'Could not start the connection', code: 'connect_failed' }, { status: 502 })
    }
    return toErrorResponse(err)
  }
}
