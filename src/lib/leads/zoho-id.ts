/**
 * The Zoho lead id the CRM bridge (n8n) reports after creating or updating a
 * lead: its answer to the delivered event carries `zoho_lead_id`. Returns the
 * first one found, or null.
 */
export function zohoLeadIdFrom(responses: unknown[] | undefined): string | null {
  for (const r of responses ?? []) {
    const candidates = Array.isArray(r) ? r : [r]
    for (const c of candidates) {
      if (c && typeof c === 'object') {
        const id = (c as Record<string, unknown>).zoho_lead_id
        if (typeof id === 'string' && /^\d{6,32}$/.test(id.trim())) return id.trim()
        if (typeof id === 'number' && Number.isFinite(id)) return String(id)
      }
    }
  }
  return null
}
