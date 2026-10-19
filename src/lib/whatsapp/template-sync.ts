import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import type { TemplateButton, TemplateSampleValues } from '@/types'

// ============================================================
// Turn the templates Meta (or Zernio, which reads them from Meta) reports
// into rows of the local `message_templates` catalog.
//
// The local catalog stores Meta's status enum verbatim (APPROVED /
// PENDING / REJECTED / PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION)
// so the edit / resubmit / delete flows can distinguish recoverable
// states (PAUSED) from terminal ones (DISABLED). Locally-created templates
// (no Meta counterpart) are NOT deleted.
// ============================================================

export interface MetaButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
}

export interface MetaTemplateComponent {
  type: string
  text?: string
  format?: string
  buttons?: MetaButton[]
  example?: {
    header_text?: string[]
    header_handle?: string[]
    body_text?: string[][]
  }
}

export interface MetaTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateComponent[]
  quality_score?: { score?: string } | string
}

function normalizeCategory(meta: string): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function normalizeQualityScore(raw: MetaTemplate['quality_score']): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score = typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null
  if (!score) return null
  const upper = score.toUpperCase()
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return []
  const out: TemplateButton[] = []
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text })
        break
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        })
        break
      case 'PHONE_NUMBER':
        out.push({ type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number ?? '' })
        break
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example) ? b.example[0] ?? '' : b.example ?? '',
        })
        break
      // OTP, FLOW, etc — out of scope for v1; drop silently.
    }
  }
  return out
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  // Meta returns body_text as a 2D array — one row per example set.
  // We take the first row (most templates have exactly one).
  const bodySample = body?.example?.body_text?.[0]
  const headerSample = header?.example?.header_text
  if (!bodySample?.length && !headerSample?.length) return null
  const sv: TemplateSampleValues = {}
  if (bodySample?.length) sv.body = bodySample
  if (headerSample?.length) sv.header = headerSample
  return sv
}

export interface TemplateSyncResult {
  inserted: number
  updated: number
  errors: { name: string; language: string; message: string }[]
}

/** Insert or update one catalog row per (name, language). */
export async function upsertTemplates(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  templates: MetaTemplate[],
): Promise<TemplateSyncResult> {
  let inserted = 0
  let updated = 0
  const errors: TemplateSyncResult['errors'] = []

  for (const t of templates) {
    const body = (t.components ?? []).find((c) => c.type.toUpperCase() === 'BODY')
    const header = (t.components ?? []).find((c) => c.type.toUpperCase() === 'HEADER')
    const footer = (t.components ?? []).find((c) => c.type.toUpperCase() === 'FOOTER')
    const buttons = (t.components ?? []).find((c) => c.type.toUpperCase() === 'BUTTONS')

    const parsedButtons = parseButtons(buttons?.buttons)
    const sampleValues = extractSampleValues(body, header)

    const headerFormat = header?.format?.toUpperCase()
    const headerType =
      headerFormat === 'TEXT' || headerFormat === 'IMAGE' || headerFormat === 'VIDEO' || headerFormat === 'DOCUMENT'
        ? headerFormat.toLowerCase()
        : null

    const row = {
      // Account tenancy + user audit. account_id is NOT NULL on
      // message_templates post-017, so an INSERT without it errors.
      account_id: accountId,
      user_id: userId,
      name: t.name,
      category: normalizeCategory(t.category),
      language: t.language,
      header_type: headerType,
      header_content: header?.text ?? null,
      header_handle: header?.example?.header_handle?.[0] ?? null,
      body_text: body?.text ?? '',
      footer_text: footer?.text ?? null,
      buttons: parsedButtons.length ? parsedButtons : null,
      sample_values: sampleValues,
      status: normalizeStatus(t.status),
      meta_template_id: t.id,
      quality_score: normalizeQualityScore(t.quality_score),
      updated_at: new Date().toISOString(),
    }

    const { data: existing, error: lookupErr } = await db
      .from('message_templates')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', t.name)
      .eq('language', t.language)
      .maybeSingle()

    if (lookupErr) {
      errors.push({ name: t.name, language: t.language, message: lookupErr.message })
      continue
    }

    if (existing?.id) {
      const { error: updErr } = await db.from('message_templates').update(row).eq('id', existing.id)
      if (updErr) errors.push({ name: t.name, language: t.language, message: updErr.message })
      else updated++
    } else {
      const { error: insErr } = await db.from('message_templates').insert(row)
      if (insErr) errors.push({ name: t.name, language: t.language, message: insErr.message })
      else inserted++
    }
  }

  return { inserted, updated, errors }
}

/** Read the connected Zernio account's templates into the local catalog. */
export async function syncZernioTemplates(
  db: SupabaseClient,
  config: { apiKey: string; zernioAccountId: string; accountId: string; userId: string },
  list: (args: { apiKey: string; accountId: string }) => Promise<MetaTemplate[]>,
): Promise<TemplateSyncResult & { total: number }> {
  const templates = await list({ apiKey: config.apiKey, accountId: config.zernioAccountId })
  const result = await upsertTemplates(db, config.accountId, config.userId, templates)
  return { ...result, total: templates.length }
}
