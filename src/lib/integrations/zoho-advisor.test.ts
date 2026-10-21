import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ findContact: vi.fn() }))
vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact: h.findContact }))

import { applyAdvisorAssigned, parseAdvisorPayload, providedSecret, secretMatches } from './zoho-advisor'

describe('parseAdvisorPayload', () => {
  it('reads the fields whatever their case or spacing', () => {
    expect(
      parseAdvisorPayload({ Mobile: '+573112580000', 'Lead Id': '4634243000153062002', AsesorAsignado: 'Fernando Solis' }),
    ).toEqual({ mobile: '+573112580000', zohoLeadId: '4634243000153062002', advisor: 'Fernando Solis' })
    expect(parseAdvisorPayload({ mobile: '3112580000', lead_id: 'x', asesor_asignado: 'Ana' })).toMatchObject({
      zohoLeadId: 'x',
      advisor: 'Ana',
    })
  })

  it('reads the owner when Zoho sends it as an object or as JSON text', () => {
    expect(parseAdvisorPayload({ Mobile: '+573112580000', AsesorAsignado: { name: 'Fernando Solis', id: '1' } })?.advisor).toBe('Fernando Solis')
    expect(parseAdvisorPayload({ Mobile: '+573112580000', AsesorAsignado: '{"name":"Fernando Solis","id":"1"}' })?.advisor).toBe('Fernando Solis')
  })

  it('works without a lead id or a rep name', () => {
    expect(parseAdvisorPayload({ Mobile: '+573112580000' })).toEqual({
      mobile: '+573112580000',
      zohoLeadId: null,
      advisor: null,
    })
  })

  it('needs a usable number or a lead id', () => {
    expect(parseAdvisorPayload({ AsesorAsignado: 'Ana' })).toBeNull()
    expect(parseAdvisorPayload({ Mobile: '123' })).toBeNull()
    expect(parseAdvisorPayload({})).toBeNull()
    // customers with a hidden number are found by the lead id alone
    expect(parseAdvisorPayload({ Lead_Id: '4634243000153062002', AsesorAsignado: 'Ana' })).toEqual({
      mobile: '',
      zohoLeadId: '4634243000153062002',
      advisor: 'Ana',
    })
  })
})

describe('providedSecret', () => {
  it('takes the header, or the same name among the form fields when Zoho put it there', () => {
    expect(providedSecret(' abc ', {})).toBe('abc')
    expect(providedSecret(null, { 'x-tuyo-secret': 'abc' })).toBe('abc')
    expect(providedSecret('', { Secret: 'abc' })).toBe('abc')
    expect(providedSecret(null, { Mobile: '1' })).toBeNull()
  })

  it('prefers the header', () => {
    expect(providedSecret('from-header', { 'x-tuyo-secret': 'from-body' })).toBe('from-header')
  })
})

describe('secretMatches', () => {
  it('accepts only the exact secret', () => {
    expect(secretMatches('abc123', 'abc123')).toBe(true)
    expect(secretMatches('abc124', 'abc123')).toBe(false)
    expect(secretMatches('abc', 'abc123')).toBe(false)
  })

  it('refuses when either side is missing', () => {
    expect(secretMatches(null, 'abc')).toBe(false)
    expect(secretMatches('abc', undefined)).toBe(false)
    expect(secretMatches('', '')).toBe(false)
  })
})

describe('applyAdvisorAssigned', () => {
  const input = { mobile: '+573112580000', zohoLeadId: 'L1', advisor: 'Fernando Solis' }

  /** `answers` are what the successive conversation lookups return (lead id first, then by contact). */
  function fakeDb(answers: ({ id: string } | null)[] | { id: string } | null, rpcError: Error | null = null) {
    const queue = Array.isArray(answers) ? [...answers] : [answers]
    const rpc = vi.fn().mockResolvedValue({ error: rpcError })
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain
    chain.maybeSingle = () => Promise.resolve({ data: queue.length > 1 ? queue.shift() : queue[0] })
    return { db: { from: () => chain, rpc } as never, rpc }
  }

  beforeEach(() => h.findContact.mockReset())

  it('finds the chat by the Zoho lead id first, without looking at the number', async () => {
    const { db, rpc } = fakeDb({ id: 'cv-9' })
    expect(await applyAdvisorAssigned(db, 'acct', input)).toEqual({ matched: true, conversationId: 'cv-9' })
    expect(rpc).toHaveBeenCalledWith('set_sales_rep', {
      p_conversation: 'cv-9',
      p_name: 'Fernando Solis',
      p_zoho_lead_id: 'L1',
    })
    expect(h.findContact).not.toHaveBeenCalled()
  })

  it('falls back to the number of the lead when no chat has that lead id yet', async () => {
    h.findContact.mockResolvedValue({ id: 'ct-1', phone: '573112580000' })
    const { db, rpc } = fakeDb([null, { id: 'cv-7' }])
    expect(await applyAdvisorAssigned(db, 'acct', input)).toEqual({ matched: true, conversationId: 'cv-7' })
    expect(h.findContact).toHaveBeenCalledWith(expect.anything(), 'acct', '+573112580000')
    expect(rpc).toHaveBeenCalledWith('set_sales_rep', expect.objectContaining({ p_conversation: 'cv-7', p_zoho_lead_id: 'L1' }))
  })

  it('a hidden-number customer is matched by the lead id alone', async () => {
    const { db } = fakeDb({ id: 'cv-5' })
    expect(await applyAdvisorAssigned(db, 'acct', { mobile: '', zohoLeadId: 'L9', advisor: 'Ana' })).toEqual({
      matched: true,
      conversationId: 'cv-5',
    })
  })

  it('says so, without failing, when there is no such contact or conversation', async () => {
    h.findContact.mockResolvedValue(null)
    expect(await applyAdvisorAssigned(fakeDb(null).db, 'acct', input)).toEqual({ matched: false, reason: 'contact_not_found' })
    expect(await applyAdvisorAssigned(fakeDb(null).db, 'acct', { mobile: '', zohoLeadId: 'L9', advisor: 'Ana' })).toEqual({
      matched: false,
      reason: 'contact_not_found',
    })
    h.findContact.mockResolvedValue({ id: 'ct-1', phone: '5731' })
    const { db, rpc } = fakeDb(null)
    expect(await applyAdvisorAssigned(db, 'acct', input)).toEqual({ matched: false, reason: 'conversation_not_found' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('throws when the database refuses the update', async () => {
    await expect(applyAdvisorAssigned(fakeDb({ id: 'cv-9' }, new Error('boom')).db, 'acct', input)).rejects.toThrow('boom')
  })
})
