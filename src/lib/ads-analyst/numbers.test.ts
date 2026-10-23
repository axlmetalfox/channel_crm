import { describe, it, expect } from 'vitest'
import { allowedFigures, extractFigures, isSourced, unsourcedFigures } from './numbers'
import { detectFindings } from './detectors'
import { BASE, snapshotOf } from './fixtures'

describe('extractFigures', () => {
  it('reads Colombian number formats', () => {
    expect(extractFigures('Cuesta $ 77.830 por lead')).toEqual([77830])
    expect(extractFigures('1,5 veces el promedio')).toEqual([1.5])
    expect(extractFigures('un gasto de 1.234.567,5 pesos')).toEqual([1234567.5])
    expect(extractFigures('el 41 % del gasto')).toEqual([41])
  })

  it('applies "mil" and "millones"', () => {
    expect(extractFigures('unos 78 mil pesos')).toEqual([78000])
    expect(extractFigures('1,2 millones de gasto')).toEqual([1_200_000])
  })

  it('ignores names, dates and ids', () => {
    expect(extractFigures('En «PROSPECCION 17-10-2026 | CO» y el 2026-10-13')).toEqual([])
    expect(extractFigures('Anuncio ID 120253857920110237')).toEqual([])
  })

  it('reads number words', () => {
    expect(extractFigures('tres anuncios y dos conjuntos')).toEqual(expect.arrayContaining([2, 3]))
    // The article "un" / "una" is not a figure.
    expect(extractFigures('un anuncio')).toEqual([])
  })
})

describe('isSourced', () => {
  it('accepts rounding but not a different figure', () => {
    expect(isSourced(78000, [77830])).toBe(true)
    expect(isSourced(5, [5.05])).toBe(true)
    expect(isSourced(90000, [77830])).toBe(false)
  })
})

describe('allowedFigures', () => {
  const snap = snapshotOf([...BASE, { id: 'bad', chats: 0 }])
  const findings = detectFindings(snap)
  const f = findings.find((x) => x.code === 'D1')!

  it('allows the figures of the finding and its entity', () => {
    const allowed = allowedFigures(snap, [f])
    expect(unsourcedFigures(`Gastó ${f.money} sin chats`, allowed)).toEqual([])
    expect(unsourcedFigures('en 14 días', allowed)).toEqual([])
  })

  it('allows 0 and 1, and the chats that came with no ad', () => {
    const allowed = allowedFigures(snap, [f])
    expect(unsourcedFigures('1 anuncio y ninguna, 0 leads', allowed)).toEqual([])
    expect(unsourcedFigures(`${snap.account.directConversations.current + 0} chats directos`, allowed)).toEqual([])
  })

  it('rejects a figure nobody gave', () => {
    const allowed = allowedFigures(snap, [f])
    expect(unsourcedFigures('trajo 37 leads', allowed)).toEqual([37])
  })
})
