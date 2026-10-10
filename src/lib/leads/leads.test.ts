import { describe, it, expect } from 'vitest'
import { LEAD_COMPLETE_SENTINEL, parseLeadCompletion } from './sentinel'
import {
  normalizeContactPhone,
  normalizeE164,
  normalizeEmail,
} from './normalize'
import { judgeLead, parseLead, type Lead } from './schema'

describe('parseLeadCompletion', () => {
  it('flags and strips the marker', () => {
    const out = parseLeadCompletion(`Tu solicitud quedó registrada. ${LEAD_COMPLETE_SENTINEL}`)
    expect(out).toEqual({ text: 'Tu solicitud quedó registrada.', complete: true })
  })

  it('leaves ordinary replies alone', () => {
    expect(parseLeadCompletion('Hola')).toEqual({ text: 'Hola', complete: false })
  })

  it('strips a marker that appears mid-text', () => {
    expect(parseLeadCompletion(`A ${LEAD_COMPLETE_SENTINEL} B`).text).toBe('A  B')
  })
})

describe('normalizeE164', () => {
  it.each([
    ['+57 311 258 0000', '+573112580000'],
    ['00573112580000', '+573112580000'],
    ['573112580000', '+573112580000'],
    ['+1 (305) 555-0100', '+13055550100'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeE164(input)).toBe(out)
  })

  it.each(['3112580000', '123', 'no phone', '', null, 42])(
    'rejects %s',
    (input) => {
      expect(normalizeE164(input)).toBeNull()
    },
  )
})

describe('normalizeContactPhone', () => {
  it('keeps a national number as plain digits', () => {
    expect(normalizeContactPhone('310 255 6678')).toBe('3102556678')
  })
  it('prefers E.164 when it can', () => {
    expect(normalizeContactPhone('+57 310 255 6678')).toBe('+573102556678')
  })
  it('drops junk', () => {
    expect(normalizeContactPhone('abc')).toBeNull()
  })
})

describe('normalizeEmail', () => {
  it('lower-cases and trims trailing punctuation', () => {
    expect(normalizeEmail(' JCperez@Lacteos.co. ')).toBe('jcperez@lacteos.co')
  })
  it('rejects malformed addresses', () => {
    expect(normalizeEmail('not an email')).toBeNull()
    expect(normalizeEmail('a@b')).toBeNull()
    expect(normalizeEmail(undefined)).toBeNull()
  })
})

const RAW = {
  first_name: ' Juan  Carlos ',
  last_name: 'Pérez Gómez',
  email: 'JC@Lacteos.co',
  company: null,
  whatsapp_number: '+57 311 258 0000',
  contact_phone: '310 255 6678',
  country: 'Colombia',
  city: 'Medellín',
  request_summary: 'Empacadora al vacío para queso.',
  request_type: 'maquina_nueva',
  consent_given: true,
}

describe('parseLead', () => {
  it('normalizes a well-formed extraction', () => {
    expect(parseLead(RAW)).toMatchObject({
      first_name: 'Juan Carlos',
      email: 'jc@lacteos.co',
      whatsapp_number: '+573112580000',
      contact_phone: '3102556678',
      company: null,
      request_type: 'maquina_nueva',
    })
  })

  it('rejects an unknown request type', () => {
    expect(parseLead({ ...RAW, request_type: 'venta' })).toBeNull()
  })

  it('rejects a missing request summary', () => {
    expect(parseLead({ ...RAW, request_summary: '  ' })).toBeNull()
  })

  it('treats anything but true as no consent', () => {
    expect(parseLead({ ...RAW, consent_given: 'yes' })?.consent_given).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(parseLead(null)).toBeNull()
    expect(parseLead('x')).toBeNull()
  })
})

describe('judgeLead', () => {
  const lead = parseLead(RAW) as Lead

  it('accepts a consented lead with a name and a way to reach them', () => {
    expect(judgeLead(lead)).toBe('ok')
  })
  it('requires consent before anything else', () => {
    expect(judgeLead({ ...lead, consent_given: false, first_name: null })).toBe(
      'no_consent',
    )
  })
  it('requires a first name', () => {
    expect(judgeLead({ ...lead, first_name: null })).toBe('incomplete')
  })
  it('requires some way to reach the customer', () => {
    expect(
      judgeLead({ ...lead, email: null, whatsapp_number: null, contact_phone: null }),
    ).toBe('incomplete')
  })
})
