import type { SupabaseClient } from '@supabase/supabase-js'
import { syncZernioTemplates, type MetaTemplate } from '@/lib/whatsapp/template-sync'
import { listZernioTemplates } from './client'
import { loadZernioConfig } from './config'

/**
 * Keep the local template catalog (message_templates) in step with what
 * Meta reports through Zernio — a template goes PENDING -> APPROVED on
 * Meta's side, and the inbox picker only offers APPROVED ones. Runs with the
 * 5-minute sweep; one cheap GET per connected account. Never throws.
 */
export async function runZernioTemplateSync(db: SupabaseClient): Promise<{ accounts: number }> {
  let accounts = 0
  try {
    const { data: rows } = await db.from('zernio_config').select('account_id').eq('is_active', true)
    for (const row of (rows ?? []) as { account_id: string }[]) {
      try {
        const config = await loadZernioConfig(db, row.account_id)
        if (!config) continue
        await syncZernioTemplates(db, config, async (args) => (await listZernioTemplates(args)) as unknown as MetaTemplate[])
        accounts += 1
      } catch (err) {
        console.error(`[zernio templates] account ${row.account_id} failed:`, err)
      }
    }
  } catch (err) {
    console.error('[zernio templates] sync failed:', err)
  }
  return { accounts }
}
