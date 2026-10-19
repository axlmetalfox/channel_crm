import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Lead } from './schema'
import {
  contactEmail,
  customerContextBlock,
  fillLeadFromRecord,
  lookupConfigured,
  lookupCustomer,
  matchIsStale,
  MAX_VERIFICATIONS_PER_CONVERSATION,
  rememberedDetailsBlock,
  resolveCustomerContext,
  verificationRequested,
  type CrmMatch,
  type CrmRecord,
} from './lookup'

const RECORD: CrmRecord = {
  first_name: 'Ana',
  last_name: 'Gómez',
  email: 'ana@x.co',
  company: 'Lácteos',
  document_id: null,
  mobile: null,
  phone: '3001112233',
  country: 'Colombia',
  city: 'Cali',
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  process.env.CUSTOMER_LOOKUP_URL = 'https://n8n.example/webhook/lookup'
  process.env.CUSTOMER_LOOKUP_SECRET = 'sekret'
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.CUSTOMER_LOOKUP_URL
  delete process.env.CUSTOMER_LOOKUP_SECRET
  delete process.env.CUSTOMER_LOOKUP_AUTO
})

const reply = (body: unknown, ok = true) =>
  fetchMock.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body })

const ASK = 'Permíteme verificar si ya te encuentras en nuestro sistema, ¿me confirmas tu correo electrónico?'

describe('contactEmail', () => {
  it('finds an email in free text', () => {
    expect(contactEmail('Mi correo es Ana@X.co, gracias')).toBe('ana@x.co')
  })
  it('ignores phone numbers and plain text', () => {
    expect(contactEmail('Mi cel es +57 300 111 2233')).toBeNull()
    expect(contactEmail('Necesito 2000 bolsas')).toBeNull()
  })
})

describe('verificationRequested', () => {
  it('is true when the last assistant message asked to verify', () => {
    expect(
      verificationRequested([
        { role: 'assistant', content: ASK },
        { role: 'user', content: 'ana@x.co' },
      ]),
    ).toBe(true)
  })
  it('is false once the bot has said something else', () => {
    expect(
      verificationRequested([
        { role: 'assistant', content: ASK },
        { role: 'user', content: 'ana@x.co' },
        { role: 'assistant', content: 'Listo' },
        { role: 'user', content: 'ok' },
      ]),
    ).toBe(false)
  })
})

describe('matchIsStale', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')
  it('checks when nothing is stored', () => expect(matchIsStale(null, now)).toBe(true))
  it('keeps a found match', () => {
    const m: CrmMatch = { status: 'found', source: 'whatsapp', checked_at: '2026-01-01T00:00:00Z' }
    expect(matchIsStale(m, now)).toBe(false)
  })
  it('re-checks an old not_found but not a fresh one', () => {
    const old: CrmMatch = { status: 'not_found', source: 'whatsapp', checked_at: '2026-10-15T01:00:00Z' }
    const fresh: CrmMatch = { status: 'not_found', source: 'whatsapp', checked_at: '2026-10-15T11:00:00Z' }
    expect(matchIsStale(old, now)).toBe(true)
    expect(matchIsStale(fresh, now)).toBe(false)
  })
})

describe('lookupCustomer', () => {
  it('is only configured with both settings', () => {
    expect(lookupConfigured()).toBe(true)
    delete process.env.CUSTOMER_LOOKUP_SECRET
    expect(lookupConfigured()).toBe(false)
  })

  it('sends the clue with the bearer secret and parses a match', async () => {
    reply({ found: true, module: 'Contacts', id: 'z1', record: { first_name: 'Ana', email: 'ANA@x.co' } })
    const out = await lookupCustomer({ phone: '573001112233' })
    expect(out).toMatchObject({ status: 'found', module: 'Contacts', id: 'z1' })
    expect(out.status === 'found' && out.record.email).toBe('ana@x.co')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://n8n.example/webhook/lookup')
    expect(init.headers.Authorization).toBe('Bearer sekret')
    expect(JSON.parse(init.body)).toEqual({ phone: '573001112233' })
  })

  it('reports not_found, and errors without throwing', async () => {
    reply({ found: false })
    expect(await lookupCustomer({ email: 'a@b.co' })).toEqual({ status: 'not_found' })
    reply({}, false)
    expect(await lookupCustomer({ email: 'a@b.co' })).toEqual({ status: 'error' })
    fetchMock.mockRejectedValue(new Error('down'))
    expect(await lookupCustomer({ email: 'a@b.co' })).toEqual({ status: 'error' })
  })
})

describe('confidentiality of what the CRM holds', () => {
  it('tells the model never to repeat stored data when a customer is verified', () => {
    for (const kind of ['registered', 'registered_by_claim'] as const) {
      expect(customerContextBlock(kind)).toMatch(/confidential/)
      expect(customerContextBlock(kind)).toMatch(/even if the customer asks/)
    }
  })

  it('shows the model none of the details already on file, only that they exist', () => {
    const block = rememberedDetailsBlock()
    expect(block).toMatch(/never read them out/i)
    expect(block).toMatch(/Do not ask for them again/)
    // No values can leak: the block takes no data at all.
    expect(rememberedDetailsBlock.length).toBe(0)
  })
})

describe('customerContextBlock', () => {
  it('gives the first name only when asked and always forbids reading data back', () => {
    const withName = customerContextBlock('registered', 'Ana')
    expect(withName).toContain('"Ana"')
    expect(withName).toMatch(/never read out/i)
    expect(customerContextBlock('registered_by_claim')).not.toContain('first name')
  })
})

describe('fillLeadFromRecord', () => {
  const empty: Lead = {
    first_name: null,
    last_name: null,
    email: null,
    company: null,
    document_id: null,
    whatsapp_number: null,
    contact_phone: null,
    country: null,
    city: null,
    department: null,
    request_summary: 'x',
    request_type: 'repuestos',
    consent_given: true,
  }
  it('fills the gaps but never overrides what the customer said', () => {
    const out = fillLeadFromRecord({ ...empty, city: 'Bogotá' }, RECORD, '573112580000')
    expect(out).toMatchObject({
      first_name: 'Ana',
      last_name: 'Gómez',
      email: 'ana@x.co',
      city: 'Bogotá',
      contact_phone: '3001112233',
      whatsapp_number: '+573112580000',
    })
  })
})

describe('resolveCustomerContext', () => {
  const saved: unknown[] = []
  const db = (phone: string | null = '573001112233') =>
    ({
      from(table: string) {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = () => Promise.resolve({ data: table === 'contacts' ? { phone } : null })
        b.update = (v: unknown) => {
          saved.push(v)
          return b
        }
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok)
        return b
      },
    }) as never
  const args = { conversationId: 'cv', contactId: 'ct', attempts: 0 }
  const fresh = (): CrmMatch => ({
    status: 'not_found',
    source: 'whatsapp',
    checked_at: new Date().toISOString(),
  })

  beforeEach(() => {
    saved.length = 0
  })

  it('looks no one up on its own by default: only when the customer says we have their details', async () => {
    reply({ found: true, module: 'Leads', id: 'z1', record: { first_name: 'Ana' } })
    // First message, number visible: nothing happens.
    expect(
      await resolveCustomerContext({
        db: db(),
        ...args,
        stored: null,
        messages: [{ role: 'user', content: 'Hola' }],
      }),
    ).toBeNull()
    // First message, number hidden: no email check is offered either.
    expect(
      await resolveCustomerContext({
        db: db(''),
        ...args,
        stored: null,
        messages: [{ role: 'user', content: 'Hola' }],
      }),
    ).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(saved.filter((v) => (v as Record<string, unknown>).crm_match)).toHaveLength(0)
  })

  it('recognises the WhatsApp number, greets by first name and remembers it', async () => {
    process.env.CUSTOMER_LOOKUP_AUTO = 'true'
    reply({ found: true, module: 'Leads', id: 'z1', record: { first_name: 'Ana' } })
    const block = await resolveCustomerContext({
      db: db(),
      ...args,
      stored: null,
      messages: [{ role: 'user', content: 'Hola' }],
    })
    expect(block).toContain('"Ana"')
    expect(saved.find((v) => (v as Record<string, unknown>).crm_match)).toMatchObject({ crm_match: { status: 'found', source: 'whatsapp', id: 'z1' } })
  })

  it('stays silent for an unknown number and does not ask again soon', async () => {
    reply({ found: false })
    const messages = [{ role: 'user', content: 'Hola' }]
    expect(await resolveCustomerContext({ db: db(), ...args, stored: null, messages })).toBeNull()
    fetchMock.mockClear()
    expect(await resolveCustomerContext({ db: db(), ...args, stored: fresh(), messages })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('verifies a claimed email after the bot asked, without leaking the name', async () => {
    reply({ found: true, module: 'Leads', id: 'z2', record: { first_name: 'Ana' } })
    const block = await resolveCustomerContext({
      db: db(),
      ...args,
      stored: fresh(),
      messages: [
        { role: 'assistant', content: ASK },
        { role: 'user', content: 'ana@x.co' },
      ],
    })
    expect(block).not.toContain('Ana')
    expect(block).toMatch(/matches a customer already registered/)
    expect(saved.find((v) => (v as Record<string, unknown>).crm_match)).toMatchObject({ crm_match: { status: 'found', source: 'claimed' } })
  })

  it('tells the model when the claimed data was not found, and when the lookup is down', async () => {
    const messages = [
      { role: 'assistant', content: ASK },
      { role: 'user', content: 'ana@x.co' },
    ]
    reply({ found: false })
    expect(
      await resolveCustomerContext({ db: db(), ...args, stored: fresh(), messages }),
    ).toMatch(/NOT found/)
    reply({}, false)
    expect(
      await resolveCustomerContext({ db: db(), ...args, stored: fresh(), messages }),
    ).toMatch(/could not be checked/)
    expect(saved.filter((v) => (v as Record<string, unknown>).crm_match)).toHaveLength(0)
  })

  it('counts every email check and stops after the limit, so it cannot probe which emails exist', async () => {
    reply({ found: false })
    const messages = [
      { role: 'assistant', content: ASK },
      { role: 'user', content: 'otro@x.co' },
    ]
    // Within the limit: the check runs and the counter goes up.
    await resolveCustomerContext({ db: db(), ...args, attempts: 2, stored: fresh(), messages })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(saved).toContainEqual({ crm_lookup_attempts: 3 })
    // At the limit: no lookup at all.
    fetchMock.mockClear()
    const out = await resolveCustomerContext({
      db: db(),
      ...args,
      attempts: MAX_VERIFICATIONS_PER_CONVERSATION,
      stored: fresh(),
      messages,
    })
    expect(out).toMatch(/no more verifications/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not look a typed phone up: verification is by email only', async () => {
    const out = await resolveCustomerContext({
      db: db(),
      ...args,
      stored: fresh(),
      messages: [
        { role: 'assistant', content: ASK },
        { role: 'user', content: 'mi cel es 3001112233' },
      ],
    })
    expect(out).toMatch(/did not give an email/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('offers the email check once, on the first reply, when the number is hidden', async () => {
    process.env.CUSTOMER_LOOKUP_AUTO = 'true'
    const first = await resolveCustomerContext({
      db: db(''),
      ...args,
      stored: null,
      messages: [{ role: 'user', content: 'Hola' }],
    })
    expect(first).toMatch(/hides their phone number/)
    expect(fetchMock).not.toHaveBeenCalled()
    // Already replied once: no second offer, no lookup.
    const later = await resolveCustomerContext({
      db: db(''),
      ...args,
      stored: null,
      messages: [
        { role: 'user', content: 'Hola' },
        { role: 'assistant', content: 'Hola, ¿cómo te llamas?' },
        { role: 'user', content: 'Ana' },
      ],
    })
    expect(later).toBeNull()
  })

  it('does not offer the check when the number is visible', async () => {
    process.env.CUSTOMER_LOOKUP_AUTO = 'true'
    reply({ found: false })
    const out = await resolveCustomerContext({
      db: db(),
      ...args,
      stored: null,
      messages: [{ role: 'user', content: 'Hola' }],
    })
    expect(out).toBeNull()
  })

  it('does not look anything up outside a verification', async () => {
    const out = await resolveCustomerContext({
      db: db(),
      ...args,
      stored: fresh(),
      messages: [
        { role: 'assistant', content: '¿Cuál es tu correo electrónico?' },
        { role: 'user', content: 'ana@x.co' },
      ],
    })
    expect(out).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
