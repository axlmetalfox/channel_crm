import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

const MIN_MINUTES = 10
// WhatsApp lets a business write freely only within 24 hours of the
// customer's last message, so the wait stays well inside that.
const MAX_MINUTES = 23 * 60
const MAX_MESSAGE_CHARS = 500

/**
 * The account's recovery message: if the customer has not answered the
 * agent after N minutes or hours, send one short message the admin wrote.
 *
 *   GET  -> { enabled, after_minutes, message }
 *   POST { enabled, value, unit: 'minutes' | 'hours', message }
 *
 * Admins only. The rule is stored with the AI configuration, so the
 * account needs that set up first.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data, error } = await supabaseAdmin()
      .from('ai_configs')
      .select('recovery_enabled, recovery_after_minutes, recovery_message')
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: 'Could not load the message' }, { status: 500 })
    if (!data) return NextResponse.json({ configured: false })
    return NextResponse.json({
      configured: true,
      enabled: data.recovery_enabled === true,
      after_minutes: data.recovery_after_minutes as number,
      message: (data.recovery_message as string | null) ?? '',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')

    const body = (await request.json().catch(() => ({}))) as {
      enabled?: unknown
      value?: unknown
      unit?: unknown
      message?: unknown
    }
    const enabled = body.enabled === true
    const value = Number(body.value)
    const unit = body.unit === 'hours' ? 'hours' : body.unit === 'minutes' ? 'minutes' : null
    if (!unit || !Number.isInteger(value) || value < 1) {
      return NextResponse.json(
        { error: 'Enter a whole number and choose minutes or hours', code: 'invalid_wait' },
        { status: 400 },
      )
    }
    const minutes = unit === 'hours' ? value * 60 : value
    if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      return NextResponse.json(
        { error: 'The wait must be between 10 minutes and 23 hours', code: 'invalid_wait' },
        { status: 400 },
      )
    }

    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (message.length > MAX_MESSAGE_CHARS) {
      return NextResponse.json(
        { error: `The message can have up to ${MAX_MESSAGE_CHARS} characters`, code: 'message_too_long' },
        { status: 400 },
      )
    }
    if (enabled && !message) {
      return NextResponse.json(
        { error: 'Write the message to send before turning this on', code: 'message_required' },
        { status: 400 },
      )
    }

    const { data, error } = await supabaseAdmin()
      .from('ai_configs')
      .update({
        recovery_enabled: enabled,
        recovery_after_minutes: minutes,
        recovery_message: message || null,
      })
      .eq('account_id', accountId)
      .select('account_id')
    if (error) {
      console.error('[recovery rule] save failed:', error)
      return NextResponse.json({ error: 'Could not save the message' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: 'Set up the AI agent first', code: 'not_configured' },
        { status: 409 },
      )
    }
    return NextResponse.json({ enabled, after_minutes: minutes, message })
  } catch (err) {
    return toErrorResponse(err)
  }
}
