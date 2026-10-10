import {
  cleanText,
  normalizeContactPhone,
  normalizeE164,
  normalizeEmail,
} from './normalize'

/** What the customer wants. Vertical-neutral; the CRM mapping lives in the
 *  receiving workflow, not here. */
export const LEAD_REQUEST_TYPES = [
  'maquina_nueva',
  'info_maquina',
  'alquiler',
  'repuestos',
  'servicio_tecnico',
] as const
export type LeadRequestType = (typeof LEAD_REQUEST_TYPES)[number]

const nullableString = { type: ['string', 'null'] }

/** Strict JSON schema the extraction call must satisfy. */
export const LEAD_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    first_name: nullableString,
    last_name: nullableString,
    email: nullableString,
    company: nullableString,
    whatsapp_number: nullableString,
    contact_phone: nullableString,
    country: nullableString,
    city: nullableString,
    request_summary: { type: 'string' },
    request_type: { type: 'string', enum: [...LEAD_REQUEST_TYPES] },
    consent_given: { type: 'boolean' },
  },
  required: [
    'first_name',
    'last_name',
    'email',
    'company',
    'whatsapp_number',
    'contact_phone',
    'country',
    'city',
    'request_summary',
    'request_type',
    'consent_given',
  ],
  additionalProperties: false,
} as const

export const LEAD_EXTRACTION_PROMPT =
  'You extract a sales lead from a WhatsApp conversation between a business assistant and a customer. ' +
  "The conversation may hold several requests from the same customer (for example a quote, then later a service call): describe only the MOST RECENT request in request_summary and request_type, and reuse the customer's details given earlier in the chat. " +
  'Return only the JSON requested. Use null for any field the customer did not state; never guess or invent values. ' +
  "Split the customer's full name into first_name (given names) and last_name (surnames; in Colombia and most of Latin America people usually have two given names and two surnames, e.g. \"Juan Carlos Pérez Gómez\" -> first_name \"Juan Carlos\", last_name \"Pérez Gómez\"). " +
  'whatsapp_number is the number the customer confirmed as their WhatsApp, in international format with "+" and country code. ' +
  'contact_phone is their phone for a call: if they said it is the same as the WhatsApp number, repeat the WhatsApp number; otherwise the number they gave. ' +
  'country and city as the customer wrote them. ' +
  "request_summary is 1-3 sentences in the customer's language describing what they need (product, presentation, machine or part, speed or other specifics), written from the conversation only. " +
  'request_type is one of: maquina_nueva (wants to buy a machine), info_maquina (asks about a specific machine or reference), alquiler (wants to rent), repuestos (needs spare parts), servicio_tecnico (needs repair or technical service). ' +
  'consent_given is true only if the customer explicitly agreed to personal-data processing.'

export interface Lead {
  first_name: string | null
  last_name: string | null
  email: string | null
  company: string | null
  whatsapp_number: string | null
  contact_phone: string | null
  country: string | null
  city: string | null
  request_summary: string
  request_type: LeadRequestType
  consent_given: boolean
}

/**
 * Validate and normalize the model's JSON. Returns null when it isn't
 * an object with a usable request (the one thing we can't recover).
 */
export function parseLead(raw: unknown): Lead | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const requestType = LEAD_REQUEST_TYPES.find((t) => t === r.request_type)
  const summary = cleanText(r.request_summary)
  if (!requestType || !summary) return null

  return {
    first_name: cleanText(r.first_name),
    last_name: cleanText(r.last_name),
    email: normalizeEmail(r.email),
    company: cleanText(r.company),
    whatsapp_number: normalizeE164(r.whatsapp_number),
    contact_phone: normalizeContactPhone(r.contact_phone),
    country: cleanText(r.country),
    city: cleanText(r.city),
    request_summary: summary,
    request_type: requestType,
    consent_given: r.consent_given === true,
  }
}

export type LeadVerdict = 'ok' | 'no_consent' | 'incomplete'

/**
 * Whether a lead may be sent on. Consent comes first: without it
 * nothing leaves wacrm. The CRM's one mandatory field is the person's
 * name, so a lead needs at least a first name and a way to reach them.
 */
export function judgeLead(lead: Lead): LeadVerdict {
  if (!lead.consent_given) return 'no_consent'
  if (!lead.first_name) return 'incomplete'
  if (!lead.whatsapp_number && !lead.contact_phone && !lead.email) {
    return 'incomplete'
  }
  return 'ok'
}
