import { describe, it, expect, vi } from 'vitest'
import { recipientName, runBulkTemplate } from './bulk-template'

describe('recipientName', () => {
  it('tidies shouted or lowercase names', () => {
    expect(recipientName({ name: 'MARIA PEREZ GOMEZ' })).toBe('Maria Perez Gomez')
    expect(recipientName({ name: 'juan  carlos' })).toBe('Juan Carlos')
  })

  it('keeps a name that is already well written', () => {
    expect(recipientName({ name: 'Ana de la Cruz' })).toBe('Ana de la Cruz')
  })

  it('falls back to a neutral word when the name is empty, a number or a handle', () => {
    expect(recipientName({ name: '' })).toBe('cliente')
    expect(recipientName(null)).toBe('cliente')
    expect(recipientName({ name: '+57 311 258 0000' })).toBe('cliente')
    expect(recipientName({ name: '573112580000' })).toBe('cliente')
    expect(recipientName({ name: '@ana.g' })).toBe('cliente')
  })

  it('caps very long names', () => {
    expect(recipientName({ name: 'A'.repeat(100) }).length).toBeLessThanOrEqual(40)
  })
})

describe('runBulkTemplate', () => {
  const items = [1, 2, 3].map((n) => ({ conversationId: `c${n}`, name: `N${n}` }))
  const sleep = vi.fn().mockResolvedValue(undefined)

  it('sends one by one, counts successes and records failures', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'window closed' })
      .mockRejectedValueOnce(new Error('network'))
    const progress = vi.fn()
    const out = await runBulkTemplate({ items, send, onProgress: progress, sleep })
    expect(out).toEqual({
      sent: 1,
      failed: [
        { conversationId: 'c2', reason: 'window closed' },
        { conversationId: 'c3', reason: 'network' },
      ],
      stopped: false,
    })
    expect(progress.mock.calls.map((c) => c[0])).toEqual([1, 2, 3])
    expect(sleep).toHaveBeenCalledTimes(2) // between sends, not after the last
  })

  it('stops before the next send when asked', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    let stop = false
    const out = await runBulkTemplate({
      items,
      send,
      sleep,
      shouldStop: () => stop,
      onProgress: (done) => {
        if (done === 1) stop = true
      },
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ sent: 1, stopped: true })
  })
})
