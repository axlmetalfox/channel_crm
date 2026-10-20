import type { SupabaseClient } from '@supabase/supabase-js'

import { setWhatsAppBlock } from '@/lib/zernio/client'
import { loadZernioConfig } from '@/lib/zernio/config'
import type { WhatsAppBlockOutcome } from './block-reasons'

export { BLOCK_REASONS, isBlockReason } from './block-reasons'
export type { BlockReason, WhatsAppBlockOutcome } from './block-reasons'

/**
 * Mirror a block (or unblock) on the WhatsApp number through Zernio. Never
 * throws: the block inside TUYO already holds, this only adds the network
 * level block, and the caller reports how it went.
 */
export async function syncWhatsAppBlock(
  db: SupabaseClient,
  args: { accountId: string; phone: string | null; block: boolean },
): Promise<WhatsAppBlockOutcome> {
  const digits = (args.phone ?? '').replace(/\D/g, '')
  if (!digits) return 'no_number'
  try {
    const config = await loadZernioConfig(db, args.accountId)
    if (!config) return 'no_channel'
    const result = await setWhatsAppBlock({
      apiKey: config.apiKey,
      accountId: config.zernioAccountId,
      users: [`+${digits}`],
      block: args.block,
    })
    if (result.done.length > 0) return 'done'
    const reasons = result.failed.flatMap((f) => f.errors).join(' ')
    return /re-?engagement|24/i.test(reasons) ? 'window_expired' : 'failed'
  } catch (err) {
    console.error('[contacts block] WhatsApp block failed:', err)
    return 'failed'
  }
}
