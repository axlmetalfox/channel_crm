import { describe, it, expect } from 'vitest'
import { isBlankTemplate } from './junk'

describe('isBlankTemplate', () => {
  it('matches the template with both blanks untouched', () => {
    expect(isBlankTemplate('¡Hola! mi nombre es ___ y busco información sobre ___')).toBe(true)
    expect(isBlankTemplate('  ¡Hola!  Mi nombre es ____  y busco informacion sobre ____ .')).toBe(true)
    expect(isBlankTemplate('hola mi nombre es ＿＿＿ y busco información sobre ＿＿＿')).toBe(true)
  })

  it('does not match when the person filled in either blank', () => {
    expect(isBlankTemplate('¡Hola! mi nombre es Felipe y busco información sobre ___')).toBe(false)
    expect(isBlankTemplate('¡Hola! mi nombre es ___ y busco información sobre máquinas de gomitas')).toBe(false)
    expect(isBlankTemplate('¡Hola! mi nombre es ___ y busco información sobre ___la máquina')).toBe(false)
  })

  it('does not match other greetings or empty input', () => {
    expect(isBlankTemplate('¡Hola! Quiero más información')).toBe(false)
    expect(isBlankTemplate('')).toBe(false)
    expect(isBlankTemplate(null)).toBe(false)
  })
})
