import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

/**
 * GET /api/zernio/status  (any member)
 *
 * Whether the account's WhatsApp is connected through Zernio. A boolean
 * only: the config row itself (key, secret) is admin-only, but every
 * member's inbox needs to know whether to show the "not connected"
 * banner.
 */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const { data, error } = await supabaseAdmin()
      .from('zernio_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .maybeSingle()
    if (error) return NextResponse.json({ connected: false })
    return NextResponse.json({ connected: !!data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
