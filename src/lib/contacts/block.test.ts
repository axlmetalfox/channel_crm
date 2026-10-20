import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  setBlock: vi.fn(),
  loadConfig: vi.fn(),
}))
vi.mock('@/lib/zernio/client', () => ({ setWhatsAppBlock: h.setBlock }))
vi.mock('@/lib/zernio/config', () => ({ loadZernioConfig: h.loadConfig }))

import { isBlockReason, syncWhatsAppBlock } from './block'

const db = {} as never
const base = { accountId: 'acct', phone: '573001234567', block: true }

beforeEach(() => {
  h.setBlock.mockReset()
  h.loadConfig.mockReset()
  h.loadConfig.mockResolvedValue({ apiKey: 'k', zernioAccountId: 'zacc' })
})

describe('isBlockReason', () => {
  it('accepts only the three reasons', () => {
    expect(isBlockReason('offensive')).toBe(true)
    expect(isBlockReason('fake')).toBe(true)
    expect(isBlockReason('other')).toBe(true)
    expect(isBlockReason('spam')).toBe(false)
    expect(isBlockReason(null)).toBe(false)
  })
})

describe('syncWhatsAppBlock', () => {
  it('blocks the number in E.164 form', async () => {
    h.setBlock.mockResolvedValue({ done: ['+573001234567'], failed: [] })
    expect(await syncWhatsAppBlock(db, base)).toBe('done')
    expect(h.setBlock).toHaveBeenCalledWith({ apiKey: 'k', accountId: 'zacc', users: ['+573001234567'], block: true })
  })

  it('reports the 24-hour limit separately from other failures', async () => {
    h.setBlock.mockResolvedValue({ done: [], failed: [{ input: '+57', errors: ['Re-engagement required'] }] })
    expect(await syncWhatsAppBlock(db, base)).toBe('window_expired')
    h.setBlock.mockResolvedValue({ done: [], failed: [{ input: '+57', errors: ['Something else'] }] })
    expect(await syncWhatsAppBlock(db, base)).toBe('failed')
  })

  it('never throws when Zernio is down', async () => {
    h.setBlock.mockRejectedValue(new Error('down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await syncWhatsAppBlock(db, base)).toBe('failed')
  })

  it('skips contacts without a visible number and accounts without Zernio', async () => {
    expect(await syncWhatsAppBlock(db, { ...base, phone: '' })).toBe('no_number')
    h.loadConfig.mockResolvedValue(null)
    expect(await syncWhatsAppBlock(db, base)).toBe('no_channel')
    expect(h.setBlock).not.toHaveBeenCalled()
  })

  it('unblocks with a DELETE-style call', async () => {
    h.setBlock.mockResolvedValue({ done: ['+573001234567'], failed: [] })
    expect(await syncWhatsAppBlock(db, { ...base, block: false })).toBe('done')
    expect(h.setBlock).toHaveBeenCalledWith(expect.objectContaining({ block: false }))
  })
})
