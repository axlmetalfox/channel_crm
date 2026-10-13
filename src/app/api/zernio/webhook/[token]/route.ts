import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadZernioConfigByToken } from '@/lib/zernio/config'
import { parseZernioEvent } from '@/lib/zernio/events'
import { processZernioInbound, processZernioStatus } from '@/lib/zernio/inbound'
import { verifyZernioSignature } from '@/lib/zernio/signature'

// The after() callback below runs inside this route's max duration; an
// AI reply (model call + send) plus lead capture can take a while.
export const maxDuration = 60

/**
 * POST /api/zernio/webhook/{token}
 *
 * Zernio's inbox webhook for one account. `{token}` is the random path
 * segment generated when the channel was connected; it identifies the
 * account, and the HMAC in `X-Zernio-Signature` (over the raw body,
 * keyed by that account's secret) proves the call is really Zernio's.
 *
 * Zernio needs a 2xx within 5 seconds and retries otherwise, so we
 * verify, acknowledge, and do the work in `after()`. Delivery is
 * at-least-once; message handling is idempotent.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const rawBody = await request.text()

  const config = await loadZernioConfigByToken(supabaseAdmin(), token).catch((err) => {
    console.error('[zernio webhook] config lookup failed:', err)
    return null
  })
  // Same answer for "unknown token" and "bad signature": nothing to learn.
  if (!config || !config.isActive) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const signature =
    request.headers.get('x-zernio-signature') ?? request.headers.get('x-late-signature')
  if (!verifyZernioSignature(rawBody, signature, config.webhookSecret)) {
    console.warn('[zernio webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Zernio's "send test event" carries `test: true`; acknowledge it.
  const event = parseZernioEvent(payload)
  if (!event) return NextResponse.json({ status: 'ignored' }, { status: 200 })

  after(async () => {
    try {
      const db = supabaseAdmin()
      if (event.kind === 'message') await processZernioInbound(db, config, event)
      else await processZernioStatus(db, config, event)
    } catch (err) {
      console.error('[zernio webhook] processing failed:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
