import { timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact } from '@/lib/contacts/dedupe'

// ============================================================
// Zoho CRM -> TUYO: the sales rep was assigned.
//
// A Zoho blueprint transition calls a webhook once the rep is assigned (the
// lead's owner). The call carries the lead's WhatsApp number (Mobile), its id
// and the rep's name. TUYO finds the conversation by the number (the lead's
// WhatsApp is always the number the customer wrote from), stores the rep and
// moves the conversation to the stage tied to 'sales_rep_assigned'.
// ============================================================

export interface AdvisorAssignedInput {
  /** The lead's WhatsApp number as Zoho has it. */
  mobile: string
  zohoLeadId: string | null
  /** The sales rep's display name, when Zoho sent one. */
  advisor: string | null
}

/** A key without case, spaces, underscores or accents: "Lead Id" == "lead_id". */
function keyOf(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object') {
    // Zoho lookups (owner) arrive as { name, id } or { Name }.
    const o = value as Record<string, unknown>
    const name = o.name ?? o.Name ?? o.full_name
    return typeof name === 'string' ? name.trim() || null : null
  }
  return null
}

/** A JSON-looking string ("{\"name\":\"Fernando\"}") is read as the object it holds. */
function unwrap(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const t = value.trim()
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      return JSON.parse(t)
    } catch {
      return value
    }
  }
  return value
}

/**
 * Read what Zoho sent, whatever the parameter names and the body format
 * (JSON, form fields or query string): the lead's mobile, its id and the
 * rep's name. Returns null when there is no usable number.
 */
export function parseAdvisorPayload(input: Record<string, unknown>): AdvisorAssignedInput | null {
  const byKey = new Map<string, unknown>()
  for (const [k, v] of Object.entries(input)) byKey.set(keyOf(k), v)
  const pick = (...names: string[]): unknown => {
    for (const n of names) {
      const v = byKey.get(keyOf(n))
      if (v !== undefined && v !== null && v !== '') return v
    }
    return undefined
  }

  const mobile = textOf(pick('mobile', 'whatsapp', 'whatsappnumber', 'phone', 'telefono', 'movil'))
  const digits = (mobile ?? '').replace(/\D/g, '')
  if (digits.length < 7) return null

  return {
    mobile: mobile as string,
    zohoLeadId: textOf(pick('leadid', 'zoholeadid', 'id', 'recordid')),
    advisor: textOf(unwrap(pick('asesorasignado', 'advisor', 'asesor', 'owner', 'leadowner', 'propietario', 'propietariodelead'))),
  }
}

/** Constant-time comparison of the shared secret. */
export function secretMatches(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type AdvisorAssignedOutcome =
  | { matched: true; conversationId: string }
  | { matched: false; reason: 'contact_not_found' | 'conversation_not_found' }

/**
 * Apply the event: find the contact by the lead's number, take its latest
 * conversation, record the rep and advance the stage.
 */
export async function applyAdvisorAssigned(
  db: SupabaseClient,
  accountId: string,
  input: AdvisorAssignedInput,
): Promise<AdvisorAssignedOutcome> {
  const contact = await findExistingContact(db, accountId, input.mobile)
  if (!contact) return { matched: false, reason: 'contact_not_found' }

  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  const conversationId = (conv as { id?: string } | null)?.id
  if (!conversationId) return { matched: false, reason: 'conversation_not_found' }

  const { error } = await db.rpc('set_sales_rep', {
    p_conversation: conversationId,
    p_name: input.advisor,
    p_zoho_lead_id: input.zohoLeadId,
  })
  if (error) throw error
  return { matched: true, conversationId }
}
