import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  ZernioError,
  checkZernioAccount,
  registerZernioWebhook,
} from '@/lib/zernio/client'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

/** Public URL of this deployment — required: it is what Zernio will call. */
function siteUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

const webhookUrlFor = (base: string, token: string) =>
  `${base}/api/zernio/webhook/${token}`

/**
 * GET /api/zernio/config  (admin+)
 * Whether the account is connected through Zernio. Never returns the key
 * or the signing secret.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('zernio_config')
      .select('zernio_account_id, webhook_token, is_active')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      // Members below admin cannot read the table (RLS): report "not
      // configured" rather than an error.
      return NextResponse.json({ configured: false })
    }
    if (!data) return NextResponse.json({ configured: false })

    const base = siteUrl()
    return NextResponse.json({
      configured: true,
      is_active: data.is_active,
      zernio_account_id: data.zernio_account_id,
      webhook_url: base ? webhookUrlFor(base, data.webhook_token) : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/zernio/config  (admin+)
 *
 * Connect (or re-connect) the account's WhatsApp through Zernio. Takes
 * the Zernio API key and the id of the WhatsApp account connected in
 * the Zernio dashboard, verifies both against Zernio, registers our
 * webhook there (with a signing secret we generate) and stores
 * everything encrypted.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`zernio-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    const zernioAccountId =
      typeof body.zernio_account_id === 'string' ? body.zernio_account_id.trim() : ''
    if (!zernioAccountId) return bad('zernio_account_id is required')

    const base = siteUrl()
    if (!base) {
      return bad(
        'NEXT_PUBLIC_SITE_URL must be set to this deployment’s https URL so Zernio can reach the webhook.',
        500,
      )
    }

    const { data: existing } = await supabase
      .from('zernio_config')
      .select('id, api_key, webhook_token, webhook_secret, zernio_account_id, zernio_webhook_id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!apiKey) return bad('api_key is required')

    // Verify the key and the account before touching anything.
    let health
    try {
      health = await checkZernioAccount(apiKey, zernioAccountId)
    } catch (err) {
      if (err instanceof ZernioError) {
        const msg =
          err.status === 401
            ? 'Zernio rejected the API key.'
            : err.status === 404
              ? 'Zernio does not know that account id.'
              : err.message
        return bad(msg, err.status === 401 || err.status === 404 ? 400 : 502)
      }
      throw err
    }
    if (health.platform && health.platform !== 'whatsapp') {
      return bad(`That Zernio account is ${health.platform}, not WhatsApp.`)
    }

    // Reuse the token and secret on a re-save so the endpoint registered
    // at Zernio keeps working; mint new ones the first time.
    const reuse = existing && existing.zernio_account_id === zernioAccountId
    const webhookToken = reuse ? existing.webhook_token : randomBytes(24).toString('base64url')
    const secretPlain = reuse ? null : `whsec_${randomBytes(32).toString('base64url')}`

    let zernioWebhookId: string | null = reuse ? existing.zernio_webhook_id : null
    if (!reuse) {
      try {
        const reg = await registerZernioWebhook({
          apiKey,
          name: 'wacrm',
          url: webhookUrlFor(base, webhookToken),
          secret: secretPlain!,
          accountId: zernioAccountId,
        })
        zernioWebhookId = reg.id
      } catch (err) {
        if (err instanceof ZernioError) {
          return bad(`Zernio refused the webhook registration: ${err.message}`, 502)
        }
        throw err
      }
    }

    const row = {
      user_id: userId,
      api_key: encrypt(apiKey),
      zernio_account_id: zernioAccountId,
      webhook_token: webhookToken,
      zernio_webhook_id: zernioWebhookId,
      is_active: true,
      ...(secretPlain ? { webhook_secret: encrypt(secretPlain) } : {}),
    }

    const { error: saveError } = existing
      ? await supabase.from('zernio_config').update(row).eq('account_id', accountId)
      : await supabase
          .from('zernio_config')
          .insert({ account_id: accountId, ...row, webhook_secret: encrypt(secretPlain!) })
    if (saveError) {
      console.error('[zernio/config POST] save error:', saveError)
      return bad('Failed to save the Zernio configuration', 500)
    }

    return NextResponse.json({
      success: true,
      webhook_url: webhookUrlFor(base, webhookToken),
      account: {
        username: health.username,
        status: health.status,
        connection: health.connection,
        inbound_webhook_subscribed: health.inboundWebhookSubscribed,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/zernio/config  (admin+)
 * Disconnect the channel. The webhook endpoint registered at Zernio is
 * not removed from here (delete it in the Zernio dashboard); with the
 * config gone wacrm answers it with 404.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('zernio_config').delete().eq('account_id', accountId)
    if (error) {
      console.error('[zernio/config DELETE] error:', error)
      return bad('Failed to disconnect', 500)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
