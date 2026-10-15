import { describe, expect, it } from 'vitest'
import { fromAcceptLanguage, isSupportedLocale, resolveLocale } from './locale'

describe('fromAcceptLanguage', () => {
  it('maps regional Spanish to es', () => {
    expect(fromAcceptLanguage('es-CO,es;q=0.9,en;q=0.8')).toBe('es')
  })
  it('honours the browser ranking, not our own order', () => {
    expect(fromAcceptLanguage('en-US,en;q=0.9,es;q=0.5')).toBe('en')
    expect(fromAcceptLanguage('fr;q=0.9,es;q=0.8')).toBe('es')
  })
  it('skips unsupported languages and q=0', () => {
    expect(fromAcceptLanguage('fr-FR,de;q=0.8')).toBeNull()
    expect(fromAcceptLanguage('es;q=0,en;q=0.5')).toBe('en')
  })
  it('handles missing or odd headers', () => {
    expect(fromAcceptLanguage(null)).toBeNull()
    expect(fromAcceptLanguage('')).toBeNull()
    expect(fromAcceptLanguage('*')).toBeNull()
  })
})

describe('resolveLocale', () => {
  it('prefers the saved cookie over everything', () => {
    expect(resolveLocale({ cookie: 'en', acceptLanguage: 'es-CO', envDefault: 'ko' })).toBe('en')
  })
  it('then the browser language', () => {
    expect(resolveLocale({ acceptLanguage: 'es-CO', envDefault: 'en' })).toBe('es')
  })
  it('then the deployment default', () => {
    expect(resolveLocale({ acceptLanguage: 'fr-FR', envDefault: 'es' })).toBe('es')
  })
  it('ignores an unsupported cookie or default and ends on English', () => {
    expect(resolveLocale({ cookie: 'xx', envDefault: 'yy' })).toBe('en')
    expect(isSupportedLocale('es')).toBe(true)
    expect(isSupportedLocale('pt')).toBe(false)
  })
})
