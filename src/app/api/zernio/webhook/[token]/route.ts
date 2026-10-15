import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadZernioConfigByToken } from '@/lib/zernio/config'
import { describeShape, parseZernioEvent } from '@/lib/zernio/events'
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

  // One line per call, so a missing message can be told apart from one we
  // received and ignored. Event names only — no message content or phones.
  const eventName =
    payload && typeof payload === 'object' && 'event' in payload
      ? String((payload as { event: unknown }).event)
      : 'unknown'
  const eventId = request.headers.get('x-zernio-event-id')
  console.info(`[zernio webhook] received ${eventName} (account ${config.accountId}, event ${eventId ?? 'n/a'})`)

  // Zernio's "send test event" carries `test: true`: acknowledge it without
  // processing, so a test can never open a conversation or trigger an AI reply.
  if (
    payload &&
    typeof payload === 'object' &&
    (payload as { test?: unknown }).test === true
  ) {
    console.info('[zernio webhook] test event acknowledged')
    return NextResponse.json({ status: 'test' }, { status: 200 })
  }

  const event = parseZernioEvent(payload)
  if (!event) {
    // Something we do not act on (reaction, account events, …) or a shape we
    // could not read. The top-level keys help tell which.
    const keys =
      payload && typeof payload === 'object' ? Object.keys(payload).join(',') : typeof payload
    console.info(
      `[zernio webhook] ignored ${eventName} (keys: ${keys}) shape=${JSON.stringify(describeShape(payload))}`,
    )
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

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
