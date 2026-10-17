import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from '@/lib/ai/types'
import { AiError } from '@/lib/ai/types'
import type { Lead } from './schema'

const h = vi.hoisted(() => ({
  extractLead: vi.fn(),
  deliver: vi.fn(),
  logAiUsage: vi.fn(),
  loadAiConfig: vi.fn(),
  reportConversion: vi.fn(),
  consent: vi.fn(),
  previousLead: vi.fn(),
  state: {
    insertError: null as { code: string } | null,
    claimOk: true,
    crmMatch: null as Record<string, unknown> | null,
    attribution: null as Record<string, unknown> | null,
    retryRows: [] as Record<string, unknown>[],
    updates: [] as { table: string; values: Record<string, unknown> }[],
    messages: [
      { sender_type: 'bot', content_text: 'Hola, ¿cómo te llamas?' },
      { sender_type: 'customer', content_text: 'Juan Pérez' },
    ] as { sender_type: string; content_text: string | null }[],
  },
}))

vi.mock('./extract', () => ({ extractLead: h.extractLead }))
vi.mock('@/lib/webhooks/deliver', () => ({ deliverWebhookEvent: h.deliver }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: h.logAiUsage }))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./conversion', () => ({ reportLeadConversion: h.reportConversion }))
vi.mock('./consent', () => ({ consentFromNotice: h.consent }))
vi.mock('./lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lookup')>()),
  previousLeadDetails: h.previousLead,
}))

import { captureLead, retryLeadIntakes } from './capture'

const INTAKE = {
  id: 'intake-1',
  account_id: 'acct-1',
  conversation_id: 'conv-1',
  contact_id: 'contact-1',
  status: 'pending',
  payload: null,
  attempts: 0,
  created_at: '2026-10-10T12:00:00.000Z',
  last_attempt_at: null,
}

/** Chainable Supabase stand-in: every filter returns the builder, and
 *  awaiting it (or .single()/.maybeSingle()) resolves per table. */
function fakeDb() {
  return {
    from(table: string) {
      let mode: 'select' | 'insert' | 'update' = 'select'
      let values: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      const resolve = () => {
        if (table === 'lead_intakes' && mode === 'insert') {
          return h.state.insertError
            ? { data: null, error: h.state.insertError }
            : { data: { ...INTAKE }, error: null }
        }
        if (mode === 'update') {
          h.state.updates.push({ table, values })
          if (table === 'lead_intakes' && 'attempts' in values) {
            return { data: h.state.claimOk ? [{ id: 'intake-1' }] : [], error: null }
          }
          return { data: null, error: null }
        }
        if (table === 'messages') return { data: [...h.state.messages].reverse(), error: null }
        if (table === 'conversations') return { data: { crm_match: h.state.crmMatch, attribution: h.state.attribution }, error: null }
        if (table === 'contacts') return { data: { phone: '573112580000' }, error: null }
        if (table === 'lead_intakes') return { data: h.state.retryRows, error: null }
        return { data: null, error: null }
      }
      for (const m of ['eq', 'in', 'lt', 'lte', 'gt', 'order', 'limit', 'select']) {
        b[m] = () => b
      }
      b.insert = (v: Record<string, unknown>) => {
        mode = 'insert'
        values = v
        return b
      }
      b.update = (v: Record<string, unknown>) => {
        mode = 'update'
        values = v
        return b
      }
      b.single = () => Promise.resolve(resolve())
      b.maybeSingle = () =>
        Promise.resolve(table === 'lead_intakes' ? { data: null, error: null } : resolve())
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(ok, bad)
      return b
    },
  } as never
}

const CONFIG = { provider: 'openai', model: 'm', apiKey: 'k' } as AiConfig

const LEAD: Lead = {
  first_name: 'Juan',
  last_name: 'Pérez',
  email: 'juan@x.co',
  company: 'Lácteos',
  document_id: null,
  whatsapp_number: '+573112580000',
  contact_phone: null,
  country: 'Colombia',
  city: 'Medellín',
  request_summary: 'Empacadora al vacío',
  request_type: 'maquina_nueva',
  consent_given: true,
}

const ARGS = {
  config: CONFIG,
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  triggerMessageId: 'wamid.1',
}

function lastStatus() {
  const done = h.state.updates.filter(
    (u) => u.table === 'lead_intakes' && 'status' in u.values,
  )
  return done[done.length - 1]?.values
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.insertError = null
  h.state.claimOk = true
  h.state.crmMatch = null
  h.state.attribution = null
  h.state.retryRows = []
  h.state.updates = []
  h.extractLead.mockResolvedValue({ lead: LEAD, usage: null })
  h.deliver.mockResolvedValue({ endpoints: 1, delivered: 1 })
  h.reportConversion.mockResolvedValue({ status: 'sent', at: '2026-10-16T05:00:00.000Z' })
  h.consent.mockResolvedValue({ given: false, at: null })
  h.previousLead.mockResolvedValue(null)
})

describe('captureLead', () => {
  it('extracts, delivers lead.captured with the intake id and marks it delivered', async () => {
    await captureLead({ db: fakeDb(), ...ARGS })

    expect(h.deliver).toHaveBeenCalledTimes(1)
    const [, accountId, event, payload, opts] = h.deliver.mock.calls[0]
    expect(accountId).toBe('acct-1')
    expect(event).toBe('lead.captured')
    expect(opts).toEqual({ eventId: 'intake-1' })
    expect(payload.lead).toMatchObject({
      first_name: 'Juan',
      last_name: 'Pérez',
      whatsapp_number: '+573112580000',
      // No separate contact phone: it falls back to the WhatsApp number.
      contact_phone: '+573112580000',
      request_type: 'maquina_nueva',
    })
    expect(payload.lead).not.toHaveProperty('consent_given')
    expect(payload.consent.given).toBe(true)
    expect(payload.channel_phone).toBe('573112580000')
    expect(payload.transcript.map((m: { role: string }) => m.role)).toEqual([
      'assistant',
      'customer',
    ])
    expect(lastStatus()).toMatchObject({ status: 'delivered', error: null })
  })

  it('closes the conversation once the lead is in the CRM', async () => {
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(
      h.state.updates.some((u) => u.table === 'conversations' && u.values.status === 'closed'),
    ).toBe(true)
  })

  it('leaves the conversation open when the lead was not delivered', async () => {
    h.deliver.mockResolvedValue({ endpoints: 1, delivered: 0 })
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(
      h.state.updates.some((u) => u.table === 'conversations' && u.values.status === 'closed'),
    ).toBe(false)
  })

  it('gives the conversation a fresh reply budget', async () => {
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(
      h.state.updates.some(
        (u) => u.table === 'conversations' && u.values.ai_reply_count === 0,
      ),
    ).toBe(true)
  })

  it('completes a registered customer from the CRM record and links the existing record', async () => {
    h.state.crmMatch = {
      status: 'found',
      source: 'whatsapp',
      checked_at: '2026-10-10T11:00:00.000Z',
      module: 'Leads',
      id: 'zoho-9',
      record: {
        first_name: 'Juan',
        last_name: 'Pérez',
        email: 'juan@crm.co',
        company: 'Lácteos',
        mobile: null,
        phone: '3001112233',
        country: 'Colombia',
        city: 'Cali',
      },
    }
    h.extractLead.mockResolvedValue({
      lead: {
        ...LEAD,
        first_name: null,
        last_name: null,
        email: null,
        company: null,
        whatsapp_number: null,
        contact_phone: null,
        country: null,
        city: null,
      },
      usage: null,
    })
    await captureLead({ db: fakeDb(), ...ARGS })

    const payload = h.deliver.mock.calls[0][3]
    expect(payload.lead).toMatchObject({
      first_name: 'Juan',
      last_name: 'Pérez',
      email: 'juan@crm.co',
      city: 'Cali',
      contact_phone: '3001112233',
      whatsapp_number: '+573112580000',
    })
    expect(payload.existing_record).toEqual({ module: 'Leads', id: 'zoho-9' })
    // The next message looks the customer up afresh.
    expect(
      h.state.updates.some((u) => u.table === 'conversations' && u.values.crm_match === null),
    ).toBe(true)
  })

  it('carries the ad the chat came from in the payload', async () => {
    h.state.attribution = {
      source_type: 'ad',
      source_id: '120210000000001',
      source_url: 'https://fb.me/abc',
      headline: 'Más precisión',
      body: null,
      media_type: 'video',
      ctwa_clid: 'AfX123',
      captured_at: '2026-10-16T04:00:00.000Z',
    }
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.deliver.mock.calls[0][3].attribution).toMatchObject({
      source_id: '120210000000001',
      ctwa_clid: 'AfX123',
    })
  })

  it('reports a delivered lead to Meta and records the outcome on the intake', async () => {
    h.state.attribution = {
      source_type: 'ad',
      source_id: '1',
      source_url: null,
      headline: null,
      body: null,
      media_type: null,
      ctwa_clid: 'AfX123',
      captured_at: '2026-10-16T04:00:00.000Z',
    }
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.reportConversion).toHaveBeenCalledTimes(1)
    const [, intake, lead, attribution] = h.reportConversion.mock.calls[0]
    expect(intake.id).toBe('intake-1')
    expect(lead.email).toBe('juan@x.co')
    expect(attribution.ctwa_clid).toBe('AfX123')
    expect(
      h.state.updates.some((u) => u.table === 'lead_intakes' && u.values.conversion),
    ).toBe(true)
  })

  it('does not report to Meta a lead that was not delivered', async () => {
    h.deliver.mockResolvedValue({ endpoints: 1, delivered: 0 })
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.reportConversion).not.toHaveBeenCalled()
  })

  it('sends attribution as null for an organic chat', async () => {
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.deliver.mock.calls[0][3].attribution).toBeNull()
  })

  it('counts continuing after the data notice as the authorization', async () => {
    h.extractLead.mockResolvedValue({ lead: { ...LEAD, consent_given: false }, usage: null })
    h.consent.mockResolvedValue({ given: true, at: '2026-10-10T11:58:00.000Z' })
    await captureLead({ db: fakeDb(), ...ARGS, config: { ...CONFIG, consentNotice: 'Al continuar…' } as AiConfig })
    const payload = h.deliver.mock.calls[0][3]
    expect(payload.consent).toEqual({
      given: true,
      captured_at: '2026-10-10T11:58:00.000Z',
      method: 'notice',
    })
    expect(lastStatus()).toMatchObject({ status: 'delivered' })
    expect(h.consent).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'Al continuar…')
  })

  it('still needs explicit consent when there was no notice in the chat', async () => {
    h.extractLead.mockResolvedValue({ lead: { ...LEAD, consent_given: false }, usage: null })
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.deliver).not.toHaveBeenCalled()
    expect(lastStatus()).toMatchObject({ status: 'no_consent' })
  })

  it('completes a new request with the details given for an earlier one in the same chat', async () => {
    h.extractLead.mockResolvedValue({
      lead: { ...LEAD, first_name: null, last_name: null, email: null, company: null, city: null, document_id: null },
      usage: null,
    })
    h.previousLead.mockResolvedValue({
      first_name: 'Ana',
      last_name: 'Gómez',
      email: 'ana@x.co',
      company: 'Lácteos',
      document_id: '900123456',
      whatsapp_number: '+573112580000',
      country: 'Colombia',
      city: 'Cali',
    })
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.deliver.mock.calls[0][3].lead).toMatchObject({
      first_name: 'Ana',
      last_name: 'Gómez',
      email: 'ana@x.co',
      document_id: '900123456',
      city: 'Cali',
    })
  })

  it('sends existing_record as null for a customer the CRM does not know', async () => {
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.deliver.mock.calls[0][3].existing_record).toBeNull()
  })

  it('does nothing when this closing message was already captured', async () => {
    h.state.insertError = { code: '23505' }
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.extractLead).not.toHaveBeenCalled()
    expect(h.deliver).not.toHaveBeenCalled()
  })

  it('sends nothing without consent and keeps no payload', async () => {
    h.extractLead.mockResolvedValue({
      lead: { ...LEAD, consent_given: false },
      usage: null,
    })
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.deliver).not.toHaveBeenCalled()
    expect(lastStatus()).toMatchObject({ status: 'no_consent' })
    expect(h.state.updates.some((u) => 'payload' in u.values)).toBe(false)
  })

  it('marks a lead without a first name incomplete', async () => {
    h.extractLead.mockResolvedValue({
      lead: { ...LEAD, first_name: null },
      usage: null,
    })
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.deliver).not.toHaveBeenCalled()
    expect(lastStatus()).toMatchObject({ status: 'incomplete' })
  })

  it('leaves the intake pending (retryable) when extraction fails', async () => {
    h.extractLead.mockRejectedValue(new AiError('boom', { code: 'timeout' }))
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.deliver).not.toHaveBeenCalled()
    expect(lastStatus()).toMatchObject({ status: 'pending', error: 'boom' })
  })

  it('records no_endpoint when nobody subscribes to lead.captured', async () => {
    h.deliver.mockResolvedValue({ endpoints: 0, delivered: 0 })
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(lastStatus()).toMatchObject({ status: 'no_endpoint' })
  })

  it('records failed when an endpoint refuses the lead', async () => {
    h.deliver.mockResolvedValue({ endpoints: 2, delivered: 1 })
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(lastStatus()).toMatchObject({
      status: 'failed',
      error: '1/2 endpoints accepted the lead',
    })
  })

  it('skips the work when another worker already claimed the intake', async () => {
    h.state.claimOk = false
    await captureLead({ db: fakeDb(), ...ARGS })
    expect(h.extractLead).not.toHaveBeenCalled()
    expect(h.deliver).not.toHaveBeenCalled()
  })
})

describe('retryLeadIntakes', () => {
  it('re-delivers a stored payload without calling the model', async () => {
    h.state.retryRows = [
      {
        ...INTAKE,
        status: 'failed',
        attempts: 1,
        last_attempt_at: '2026-10-10T11:00:00.000Z',
        payload: { intake_id: 'intake-1', lead: {} },
      },
    ]
    const out = await retryLeadIntakes(fakeDb(), {
      now: new Date('2026-10-10T12:30:00.000Z'),
    })
    expect(out).toEqual({ checked: 1, delivered: 1 })
    expect(h.extractLead).not.toHaveBeenCalled()
    expect(h.deliver).toHaveBeenCalledTimes(1)
  })

  it('waits out the backoff before retrying', async () => {
    h.state.retryRows = [
      {
        ...INTAKE,
        status: 'failed',
        attempts: 3,
        last_attempt_at: '2026-10-10T12:25:00.000Z',
        payload: { intake_id: 'intake-1', lead: {} },
      },
    ]
    // 3 attempts => 8 minute wait; only 5 minutes have passed.
    const out = await retryLeadIntakes(fakeDb(), {
      now: new Date('2026-10-10T12:30:00.000Z'),
    })
    expect(out).toEqual({ checked: 0, delivered: 0 })
    expect(h.deliver).not.toHaveBeenCalled()
  })

  it('re-runs extraction for an intake that never got a payload', async () => {
    h.loadAiConfig.mockResolvedValue(CONFIG)
    h.state.retryRows = [{ ...INTAKE, attempts: 1, last_attempt_at: '2026-10-10T11:00:00.000Z' }]
    const out = await retryLeadIntakes(fakeDb(), {
      now: new Date('2026-10-10T12:30:00.000Z'),
    })
    expect(h.extractLead).toHaveBeenCalledTimes(1)
    expect(out.delivered).toBe(1)
  })
})
