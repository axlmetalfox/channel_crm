import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

/**
 * GET /api/whatsapp/connection  (any member)
 *
 * Whether the account's WhatsApp number is connected, as the 5-minute sweep
 * last read it. Returns only the status fields: zernio_config also holds the
 * encrypted API key and is not readable by advisors, hence this route.
 */
export async function GET() {
  try {
    const { accountId } = await requireRole('viewer')
    const { data } = await supabaseAdmin()
      .from('zernio_config')
      .select('connection_status, connection_down_since, connection_checked_at, connection_detail')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .maybeSingle()
    if (!data) return NextResponse.json({ configured: false })
    const row = data as {
      connection_status: string
      connection_down_since: string | null
      connection_checked_at: string | null
      connection_detail: string | null
    }
    return NextResponse.json({
      configured: true,
      status: row.connection_status,
      down_since: row.connection_down_since,
      checked_at: row.connection_checked_at,
      detail: row.connection_detail,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
