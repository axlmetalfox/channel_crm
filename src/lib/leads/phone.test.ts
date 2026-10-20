import { describe, it, expect } from 'vitest'
import type { Lead } from './schema'
import { reconcileWhatsApp, samePhone } from './phone'

const lead = (whatsapp: string | null): Lead => ({
  first_name: 'Ana',
  last_name: 'Gómez',
  email: null,
  company: null,
  document_id: null,
  whatsapp_number: whatsapp,
  contact_phone: null,
  country: 'Colombia',
  city: 'Cali',
  department: null,
  request_summary: 'x',
  request_type: 'maquina_nueva',
  consent_given: true,
})

describe('samePhone', () => {
  it('matches with or without the country code and punctuation', () => {
    expect(samePhone('+57 311 258 0000', '573112580000')).toBe(true)
    expect(samePhone('3112580000', '+573112580000')).toBe(true)
  })

  it('tells different numbers apart, including a mistyped digit', () => {
    expect(samePhone('+573112580001', '+573112580000')).toBe(false)
    expect(samePhone('+573112580000', '+50768959710')).toBe(false)
  })

  it('never matches an empty value', () => {
    expect(samePhone('', '')).toBe(false)
    expect(samePhone(null, '3112580000')).toBe(false)
  })
})

describe('reconcileWhatsApp', () => {
  it('uses the number the customer wrote from, in international form', () => {
    const out = reconcileWhatsApp(lead('3112580000'), '573112580000')
    expect(out.lead.whatsapp_number).toBe('+573112580000')
    expect(out.reported).toBeNull() // same line, only written differently
  })

  it('overrides a mistyped number and remembers what was typed', () => {
    const out = reconcileWhatsApp(lead('+573112580001'), '573112580000')
    expect(out.lead.whatsapp_number).toBe('+573112580000')
    expect(out.reported).toBe('+573112580001')
  })

  it('fills the number when the customer gave none', () => {
    const out = reconcileWhatsApp(lead(null), '573112580000')
    expect(out.lead.whatsapp_number).toBe('+573112580000')
    expect(out.reported).toBeNull()
  })

  it('leaves the lead alone when the chat has no visible number', () => {
    const l = lead('+573112580001')
    expect(reconcileWhatsApp(l, null)).toEqual({ lead: l, reported: null })
    expect(reconcileWhatsApp(l, '')).toEqual({ lead: l, reported: null })
  })

  it('keeps a separate contact phone the customer gave', () => {
    const l = { ...lead('+573112580001'), contact_phone: '+576015550000' }
    expect(reconcileWhatsApp(l, '573112580000').lead.contact_phone).toBe('+576015550000')
  })
})
