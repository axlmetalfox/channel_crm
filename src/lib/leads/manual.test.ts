import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from '@/lib/ai/types'
import type { Lead } from './schema'

const h = vi.hoisted(() => ({
  extractLead: vi.fn(),
  processIntake: vi.fn(),
  loadMessages: vi.fn(),
  logAiUsage: vi.fn(),
  state: {
    conversation: null as Record<string, unknown> | null,
    contactPhone: '573112580000' as string | null,
    delivered: null as { delivered_at: string } | null,
    draftRow: null as Record<string, unknown> | null,
    inserted: null as Record<string, unknown> | null,
    updated: null as Record<string, unknown> | null,
    validate: true as boolean,
  },
}))

vi.mock('./extract', () => ({ extractLead: h.extractLead }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: h.logAiUsage }))
vi.mock('./capture', () => ({
  loadInterviewMessages: h.loadMessages,
  processIntake: h.processIntake,
  trimTranscript: (m: { role: string; content: string }[]) =>
    m.map((x) => ({ role: x.role === 'user' ? 'customer' : 'assistant', text: x.content })),
}))

import { ManualLeadError, prepareManualLead, submitManualLead } from './manual'

const CONFIG = { provider: 'openai', model: 'm', apiKey: 'k' } as AiConfig

const EXTRACTED: Lead = {
  first_name: 'Ana',
  last_name: 'Gómez',
  email: null,
  company: null,
  document_id: null,
  whatsapp_number: null,
  contact_phone: null,
  country: 'Colombia',
  city: null,
  request_summary: 'Empacadora de sachets',
  request_type: 'maquina_nueva',
  consent_given: true,
}

function fakeDb() {
  return {
    from(table: string) {
      let mode: 'select' | 'insert' | 'update' = 'select'
      let values: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b
      b.insert = (v: Record<string, unknown>) => ((mode = 'insert'), (values = v), b)
      b.update = (v: Record<string, unknown>) => ((mode = 'update'), (values = v), b)
      const result = () => {
        if (table === 'lead_intakes' && mode === 'insert') {
          h.state.inserted = values
          return { data: { id: 'draft-1' }, error: null }
        }
        if (table === 'lead_intakes' && mode === 'update') {
          h.state.updated = values
          return { error: null }
        }
        return { data: null, error: null }
      }
      b.single = () => Promise.resolve(result())
      b.maybeSingle = () => {
        if (table === 'conversations') return Promise.resolve({ data: h.state.conversation })
        if (table === 'contacts') return Promise.resolve({ data: { phone: h.state.contactPhone } })
        if (table === 'accounts') return Promise.resolve({ data: { validate_manual_leads: h.state.validate } })
        if (table === 'lead_intakes') {
          return Promise.resolve({ data: h.state.draftRow ?? h.state.delivered })
        }
        return Promise.resolve({ data: null })
      }
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok)
      return b
    },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.conversation = { id: 'cv-1', contact_id: 'ct-1', crm_match: null, attribution: null }
  h.state.contactPhone = '573112580000'
  h.state.delivered = null
  h.state.draftRow = null
  h.state.inserted = null
  h.state.updated = null
  h.state.validate = true
  h.loadMessages.mockResolvedValue([
    { role: 'assistant', content: 'Hola' },
    { role: 'user', content: 'Quiero sachets' },
  ])
  h.extractLead.mockResolvedValue({ lead: { ...EXTRACTED }, usage: null })
  h.processIntake.mockResolvedValue('delivered')
})

const ARGS = { accountId: 'acct-1', conversationId: 'cv-1', userId: 'user-1' }

describe('prepareManualLead', () => {
  it('proposes the lead, fills the chat number and keeps a draft out of the retry queue', async () => {
    const out = await prepareManualLead(fakeDb(), CONFIG, ARGS)
    expect(out.intakeId).toBe('draft-1')
    expect(out.lead).toMatchObject({ first_name: 'Ana', whatsapp_number: '+573112580000' })
    expect(out.lead).not.toHaveProperty('consent_given')
    expect(out.consentGiven).toBe(true)
    expect(h.state.inserted).toMatchObject({
      status: 'draft',
      source: 'manual',
      created_by_user_id: 'user-1',
      account_id: 'acct-1',
    })
    expect(String(h.state.inserted?.trigger_message_id)).toMatch(/^manual:/)
    expect(h.processIntake).not.toHaveBeenCalled()
  })

  it('reports when the chat shows no consent and when a lead was already delivered', async () => {
    h.extractLead.mockResolvedValue({ lead: { ...EXTRACTED, consent_given: false }, usage: null })
    h.state.delivered = { delivered_at: '2026-10-16T10:00:00.000Z' }
    const out = await prepareManualLead(fakeDb(), CONFIG, ARGS)
    expect(out.consentGiven).toBe(false)
    expect(out.alreadyDeliveredAt).toBe('2026-10-16T10:00:00.000Z')
  })

  it('refuses an unknown conversation and an empty chat', async () => {
    h.state.conversation = null
    await expect(prepareManualLead(fakeDb(), CONFIG, ARGS)).rejects.toMatchObject({ code: 'not_found' })
    h.state.conversation = { id: 'cv-1', contact_id: 'ct-1', crm_match: null, attribution: null }
    h.loadMessages.mockResolvedValue([])
    await expect(prepareManualLead(fakeDb(), CONFIG, ARGS)).rejects.toMatchObject({ code: 'no_messages' })
  })
})

describe('submitManualLead', () => {
  const draft = (consent = true, by = 'user-1', status = 'draft') => ({
    id: 'draft-1',
    account_id: 'acct-1',
    conversation_id: 'cv-1',
    contact_id: 'ct-1',
    status,
    created_by_user_id: by,
    draft: { lead: { ...EXTRACTED, whatsapp_number: '+573112580000', consent_given: consent } },
    created_at: '2026-10-16T12:00:00.000Z',
  })
  const edits = {
    first_name: 'Ana',
    last_name: 'Gómez Ruiz',
    email: 'ANA@x.co',
    company: 'Lácteos',
    whatsapp_number: '+573112580000',
    contact_phone: '',
    country: 'Colombia',
    city: 'Cali',
    request_summary: 'Empacadora de sachets',
    request_type: 'maquina_nueva',
    consent_given: true,
  }
  // What the customer wrote in the chat: every detail the form holds.
  const customerSaid = [
    { role: 'assistant', content: 'Hola, ¿cuál es su correo y su ciudad?' },
    { role: 'user', content: 'Soy Ana Gómez Ruiz de Lácteos, mi correo es ANA@x.co, en Cali' },
  ]
  const args = (over: Record<string, unknown> = {}) => ({
    accountId: 'acct-1',
    intakeId: 'draft-1',
    userId: 'user-1',
    userName: 'Elcy Cubillos',
    edits,
    ...over,
  })

  it('delivers the reviewed lead marked as registered by the agent', async () => {
    h.state.draftRow = draft()
    h.loadMessages.mockResolvedValue(customerSaid)
    const out = await submitManualLead(fakeDb(), args())
    expect(out.status).toBe('delivered')
    const payload = h.state.updated?.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      intake_id: 'draft-1',
      registered_by: { user_id: 'user-1', name: 'Elcy Cubillos' },
      lead: { last_name: 'Gómez Ruiz', email: 'ana@x.co', city: 'Cali' },
    })
    expect(h.state.updated).toMatchObject({ status: 'pending', attempts: 0 })
    expect(h.processIntake).toHaveBeenCalledTimes(1)
  })

  it('sends the notes along, trimmed and capped', async () => {
    h.state.draftRow = draft()
    h.loadMessages.mockResolvedValue(customerSaid)
    await submitManualLead(fakeDb(), args({ edits: { ...edits, notes: '  Prefiere llamada\nen la tarde  ' } }))
    expect((h.state.updated?.payload as Record<string, unknown>).notes).toBe('Prefiere llamada\nen la tarde')
    await submitManualLead(fakeDb(), args({ edits: { ...edits, notes: 'x'.repeat(5000) } }))
    expect(((h.state.updated?.payload as Record<string, unknown>).notes as string).length).toBe(2000)
    await submitManualLead(fakeDb(), args({ edits: { ...edits, notes: '   ' } }))
    expect((h.state.updated?.payload as Record<string, unknown>).notes).toBeNull()
  })

  it('refuses data the customer never wrote and says which fields', async () => {
    h.state.draftRow = draft()
    h.loadMessages.mockResolvedValue(customerSaid)
    await expect(
      submitManualLead(fakeDb(), args({ edits: { ...edits, email: 'inventado@x.co', city: 'Bogotá' } })),
    ).rejects.toMatchObject({ code: 'unverified_data', fields: ['email', 'city'] })
    expect(h.processIntake).not.toHaveBeenCalled()
  })

  it('does not accept a value only the agent or the AI wrote', async () => {
    h.state.draftRow = draft()
    h.loadMessages.mockResolvedValue([
      { role: 'assistant', content: 'Anotado: inventado@x.co en Bogotá' },
      { role: 'user', content: 'Soy Ana Gómez Ruiz de Lácteos, mi correo es ANA@x.co, en Cali' },
    ])
    await expect(
      submitManualLead(fakeDb(), args({ edits: { ...edits, email: 'inventado@x.co' } })),
    ).rejects.toMatchObject({ code: 'unverified_data', fields: ['email'] })
  })

  it('accepts any value when the admin turned the data check off, but still needs the required fields', async () => {
    h.state.draftRow = draft()
    h.state.validate = false
    h.loadMessages.mockResolvedValue(customerSaid)
    const out = await submitManualLead(
      fakeDb(),
      args({ edits: { ...edits, email: 'otro@x.co', city: 'Bogotá' } }),
    )
    expect(out.status).toBe('delivered')
    expect(h.state.updated?.payload).toMatchObject({ lead: { email: 'otro@x.co', city: 'Bogotá' } })
    await expect(
      submitManualLead(fakeDb(), args({ edits: { ...edits, email: '' } })),
    ).rejects.toMatchObject({ code: 'incomplete', fields: ['email'] })
  })

  it('tells the form whether the data check is on', async () => {
    expect((await prepareManualLead(fakeDb(), CONFIG, ARGS)).validateData).toBe(true)
    h.state.validate = false
    expect((await prepareManualLead(fakeDb(), CONFIG, ARGS)).validateData).toBe(false)
  })

  it('requires name, surname, WhatsApp, email and city', async () => {
    h.state.draftRow = draft()
    h.loadMessages.mockResolvedValue(customerSaid)
    await expect(
      submitManualLead(fakeDb(), args({ edits: { ...edits, last_name: '', email: '', city: '' } })),
    ).rejects.toMatchObject({ code: 'incomplete', fields: ['last_name', 'email', 'city'] })
    expect(h.processIntake).not.toHaveBeenCalled()
  })

  it('takes consent from the stored draft, not from the browser', async () => {
    h.state.draftRow = draft(false)
    await expect(submitManualLead(fakeDb(), args())).rejects.toMatchObject({ code: 'consent_required' })
    expect(h.processIntake).not.toHaveBeenCalled()
  })

  it('refuses someone else\'s draft, a sent draft and an unusable form', async () => {
    h.state.draftRow = draft(true, 'someone-else')
    await expect(submitManualLead(fakeDb(), args())).rejects.toMatchObject({ code: 'not_found' })
    h.state.draftRow = draft(true, 'user-1', 'delivered')
    await expect(submitManualLead(fakeDb(), args())).rejects.toMatchObject({ code: 'already_submitted' })
    h.state.draftRow = draft()
    await expect(
      submitManualLead(fakeDb(), args({ edits: { ...edits, request_type: 'nada' } })),
    ).rejects.toMatchObject({ code: 'invalid_lead' })
    await expect(
      submitManualLead(fakeDb(), args({ edits: { ...edits, first_name: '', whatsapp_number: '', email: '' } })),
    ).rejects.toBeInstanceOf(ManualLeadError)
    expect(h.processIntake).not.toHaveBeenCalled()
  })
})
