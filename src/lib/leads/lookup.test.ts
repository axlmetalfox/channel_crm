import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Lead } from './schema'
import {
  contactClues,
  customerContextBlock,
  fillLeadFromRecord,
  lookupConfigured,
  lookupCustomer,
  matchIsStale,
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
})

const reply = (body: unknown, ok = true) =>
  fetchMock.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body })

const ASK = 'Permíteme verificar si ya te encuentras en nuestro sistema, ¿me confirmas tu correo?'

describe('contactClues', () => {
  it('finds an email and a phone in free text', () => {
    expect(contactClues('Mi correo es Ana@X.co y mi cel +57 300 111 2233')).toEqual({
      email: 'ana@x.co',
      phone: '573001112233',
    })
  })
  it('ignores short numbers and plain text', () => {
    expect(contactClues('Necesito 2000 bolsas')).toEqual({ email: null, phone: null })
  })
  it('does not take the digits of an email as a phone', () => {
    expect(contactClues('a3001112233@x.co').phone).toBeNull()
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

describe('customerContextBlock', () => {
  it('gives the first name only when asked and always forbids reading data back', () => {
    const withName = customerContextBlock('registered', 'Ana')
    expect(withName).toContain('"Ana"')
    expect(withName).toMatch(/Never read out/)
    expect(customerContextBlock('registered_by_claim')).not.toContain('first name')
  })
})

describe('fillLeadFromRecord', () => {
  const empty: Lead = {
    first_name: null,
    last_name: null,
    email: null,
    company: null,
    whatsapp_number: null,
    contact_phone: null,
    country: null,
    city: null,
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
  const args = { conversationId: 'cv', contactId: 'ct' }
  const fresh = (): CrmMatch => ({
    status: 'not_found',
    source: 'whatsapp',
    checked_at: new Date().toISOString(),
  })

  beforeEach(() => {
    saved.length = 0
  })

  it('recognises the WhatsApp number, greets by first name and remembers it', async () => {
    reply({ found: true, module: 'Leads', id: 'z1', record: { first_name: 'Ana' } })
    const block = await resolveCustomerContext({
      db: db(),
      ...args,
      stored: null,
      messages: [{ role: 'user', content: 'Hola' }],
    })
    expect(block).toContain('"Ana"')
    expect(saved[0]).toMatchObject({ crm_match: { status: 'found', source: 'whatsapp', id: 'z1' } })
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
    expect(saved[0]).toMatchObject({ crm_match: { status: 'found', source: 'claimed' } })
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
    expect(saved).toHaveLength(0)
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
