import { describe, it, expect } from 'vitest'
import { isSocialShareOnly } from './social-links'

describe('isSocialShareOnly', () => {
  it('matches a message that is just a shared social link', () => {
    for (const text of [
      'https://www.facebook.com/share/r/1GwhWZ8toN/',
      'https://www.facebook.com/share/v/abc123/',
      '  https://m.facebook.com/reel/123456 ',
      'https://fb.watch/xyz/',
      'https://www.instagram.com/reel/Cabc123/',
      'https://vm.tiktok.com/ZMabc/',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/abc',
      'https://x.com/user/status/1',
    ]) {
      expect(isSocialShareOnly(text), text).toBe(true)
    }
  })

  it('does not match anything a person actually wrote', () => {
    for (const text of [
      'Mira esto https://www.facebook.com/share/r/1GwhWZ8toN/',
      'https://www.facebook.com/share/r/1GwhWZ8toN/ ¿cuánto cuesta esta máquina?',
      'Hola, quiero información',
      '',
      '   ',
    ]) {
      expect(isSocialShareOnly(text), text).toBe(false)
    }
    expect(isSocialShareOnly(null)).toBe(false)
  })

  it('leaves other links and Meta ad links alone', () => {
    for (const text of [
      'https://intertec.com.co/maquinas/flow-pack',
      'https://fb.me/kFX7jWKRc',
      'https://example.com/facebook.com',
      'https://notfacebook.com/share/r/1',
      'ftp://facebook.com/x',
      'facebook.com/share/r/1',
    ]) {
      expect(isSocialShareOnly(text), text).toBe(false)
    }
  })
})
