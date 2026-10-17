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
    draft: { lead: { ...EXTRACTED, consent_given: consent } },
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
