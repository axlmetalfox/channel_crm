import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import {
  applyAdvisorAssigned,
  parseAdvisorPayload,
  providedSecret,
  secretMatches,
} from '@/lib/integrations/zoho-advisor'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whatever Zoho sends (JSON, form fields, query string) as one flat object. */
async function readInput(request: Request): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  new URL(request.url).searchParams.forEach((v, k) => {
    // the secret never travels in the query string
    if (!/secret/i.test(k)) out[k] = v
  })
  const type = request.headers.get('content-type') ?? ''
  try {
    if (type.includes('application/json')) {
      const body = (await request.json()) as unknown
      if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(out, body)
    } else if (type.includes('form')) {
      const form = await request.formData()
      form.forEach((v, k) => {
        if (typeof v === 'string') out[k] = v
      })
    }
  } catch {
    // an unreadable body: only the query string counts
  }
  return out
}

/**
 * POST /api/integrations/zoho/advisor-assigned?account=<uuid>
 * Header: x-tuyo-secret: <ZOHO_INBOUND_SECRET>
 *
 * Called by a Zoho CRM blueprint transition once the sales rep is assigned.
 * Fields (any of these names): Mobile, LeadId, AsesorAsignado. Always answers
 * 200 once authorized, with `matched` telling whether a conversation was
 * found, so a lead that did not come from TUYO never fails the transition in
 * Zoho.
 */
export async function POST(request: Request) {
  const expected = process.env.ZOHO_INBOUND_SECRET?.trim()
  if (!expected) {
    console.warn('[zoho advisor-assigned] rejected: ZOHO_INBOUND_SECRET is not set')
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const input = await readInput(request)
  const provided = providedSecret(request.headers.get('x-tuyo-secret'), input)
  if (!secretMatches(provided, expected)) {
    // Names only, never values: tells a missing header from a wrong value.
    console.warn(
      '[zoho advisor-assigned] rejected: secret',
      provided ? 'does not match' : 'not sent',
      '| headers:',
      [...request.headers.keys()].filter((h) => !/^(x-forwarded|x-real|host|connection|accept)/i.test(h)).join(','),
      '| fields:',
      Object.keys(input).join(','),
    )
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limit = checkRateLimit('zoho-inbound:advisor', { limit: 120, windowMs: 60_000 })
  if (!limit.success) return rateLimitResponse(limit)

  const accountId = new URL(request.url).searchParams.get('account') ?? ''
  if (!UUID.test(accountId)) {
    console.warn('[zoho advisor-assigned] rejected: the URL has no valid ?account=')
    return NextResponse.json({ error: 'account is required' }, { status: 400 })
  }

  // Field names only: the values are customer data.
  console.info('[zoho advisor-assigned] received fields:', Object.keys(input).filter((k) => !/secret/i.test(k)).join(','))
  const parsed = parseAdvisorPayload(input)
  if (!parsed) {
    console.warn('[zoho advisor-assigned] rejected: no usable mobile or lead id')
    return NextResponse.json({ error: 'A mobile number is required' }, { status: 400 })
  }

  try {
    const outcome = await applyAdvisorAssigned(supabaseAdmin(), accountId, parsed)
    if (!outcome.matched) {
      console.info('[zoho advisor-assigned] no conversation:', outcome.reason)
      return NextResponse.json({ ok: true, matched: false })
    }
    return NextResponse.json({ ok: true, matched: true })
  } catch (err) {
    console.error('[zoho advisor-assigned] failed:', err)
    return NextResponse.json({ error: 'Could not apply it' }, { status: 500 })
  }
}
