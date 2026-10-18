import { describe, it, expect } from 'vitest'
import { missingManualFields, unverifiedFields } from './evidence'

const base = {
  first_name: 'Ana',
  last_name: 'Gómez',
  email: 'ana@x.co',
  company: null,
  document_id: null,
  whatsapp_number: '+573112580000',
  contact_phone: null,
  country: 'Colombia',
  city: 'Cali',
}

describe('unverifiedFields', () => {
  it('accepts exactly what was proposed, even if the chat never says it', () => {
    expect(unverifiedFields(base, base, [])).toEqual([])
  })

  it('accepts a correction the customer wrote, ignoring case, accents and spacing', () => {
    const texts = ['Mi correo es ANA.GOMEZ@x.co', 'Soy Ana María Gomez Ruiz', 'estoy en Medellín, mi cel 311 258 0001']
    expect(
      unverifiedFields(
        {
          ...base,
          email: 'ana.gomez@x.co',
          first_name: 'Ana María',
          last_name: 'Gómez Ruiz',
          city: 'medellin',
          whatsapp_number: '+573112580001',
        },
        base,
        texts,
      ),
    ).toEqual([])
  })

  it('rejects data the customer never wrote', () => {
    const texts = ['Hola, quiero una empacadora', 'Me llamo Ana Gómez']
    expect(
      unverifiedFields(
        { ...base, email: 'inventado@x.co', whatsapp_number: '+573009998877', city: 'Bogotá', document_id: '900123456' },
        base,
        texts,
      ),
    ).toEqual(['email', 'document_id', 'whatsapp_number', 'city'])
  })

  it('rejects when only part of a name is in the customer\'s messages', () => {
    expect(
      unverifiedFields({ ...base, last_name: 'Gómez Pardo' }, base, ['Me llamo Ana Gómez']),
    ).toEqual(['last_name'])
  })

  it('does not count what agents or the AI wrote (only customer texts are passed in)', () => {
    // The caller passes customer messages only; a value that appears solely
    // elsewhere must fail.
    expect(unverifiedFields({ ...base, email: 'asesor@x.co' }, base, ['Hola'])).toEqual(['email'])
  })

  it('matches a document id however it was typed', () => {
    expect(
      unverifiedFields({ ...base, document_id: '900123456-7' }, base, ['mi nit es 900.123.456-7']),
    ).toEqual([])
  })

  it('always allows emptying a field', () => {
    expect(unverifiedFields({ ...base, email: null, city: null }, base, [])).toEqual([])
  })

  it('accepts a phone the customer typed with or without the country code', () => {
    expect(
      unverifiedFields({ ...base, contact_phone: '+573205550000' }, base, ['llámame al 3205550000']),
    ).toEqual([])
  })
})

describe('missingManualFields', () => {
  it('requires name, surname, WhatsApp, email and city', () => {
    expect(missingManualFields(base)).toEqual([])
    expect(missingManualFields({ ...base, last_name: null, email: null, city: null })).toEqual([
      'last_name',
      'email',
      'city',
    ])
  })
})
