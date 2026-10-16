import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  loadZernioConfig: vi.fn(),
  getDataset: vi.fn(),
  provision: vi.fn(),
  send: vi.fn(),
  convRow: { zernio_conversation_id: 'zconv-1' } as { zernio_conversation_id: string | null } | null,
}))

vi.mock('@/lib/zernio/config', () => ({ loadZernioConfig: h.loadZernioConfig }))
vi.mock('@/lib/zernio/client', () => {
  class ZernioError extends Error {
    status: number
    code: string | null
    constructor(message: string, status: number, code: string | null = null) {
      super(message)
      this.status = status
      this.code = code
    }
  }
  return {
    ZernioError,
    getWhatsAppDataset: h.getDataset,
    provisionWhatsAppDataset: h.provision,
    sendWhatsAppConversion: h.send,
  }
})

import { reportLeadConversion } from './conversion'
import { ZernioError } from '@/lib/zernio/client'

const db = {
  from: () => {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.maybeSingle = () => Promise.resolve({ data: h.convRow })
    return b
  },
} as never

const INTAKE = { id: 'intake-1', account_id: 'acct-1', conversation_id: 'conv-1' }
const AD = { ctwa_clid: 'AfX123' }

beforeEach(() => {
  vi.clearAllMocks()
  h.convRow = { zernio_conversation_id: 'zconv-1' }
  h.loadZernioConfig.mockResolvedValue({ apiKey: 'sk_x', zernioAccountId: 'zacc' })
  h.getDataset.mockResolvedValue({ datasetId: 'ds-1' })
  h.send.mockResolvedValue({ eventsReceived: 1, eventsFailed: 0, failures: [], traceId: 'tr-1' })
})
afterEach(() => {
  delete process.env.META_CONVERSION_TEST_CODE
})

describe('reportLeadConversion', () => {
  it('sends a LeadSubmitted event keyed by the intake id', async () => {
    const out = await reportLeadConversion(db, INTAKE, { email: 'a@b.co' }, AD)
    expect(out).toMatchObject({ status: 'sent', trace_id: 'tr-1' })
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'zacc',
        conversationId: 'zconv-1',
        eventName: 'LeadSubmitted',
        eventId: 'intake-1',
        email: 'a@b.co',
      }),
    )
    expect(h.provision).not.toHaveBeenCalled()
  })

  it('provisions the dataset the first time', async () => {
    h.getDataset.mockResolvedValue({ datasetId: null })
    h.provision.mockResolvedValue({ datasetId: 'ds-new', created: true })
    await reportLeadConversion(db, INTAKE, { email: null }, AD)
    expect(h.provision).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('routes the event to Meta Test Events when a test code is set', async () => {
    process.env.META_CONVERSION_TEST_CODE = 'TEST123'
    await reportLeadConversion(db, INTAKE, { email: null }, AD)
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ testCode: 'TEST123' }))
  })

  it('skips a chat that did not come from an ad, without calling Zernio', async () => {
    const out = await reportLeadConversion(db, INTAKE, { email: null }, null)
    expect(out.status).toBe('skipped')
    expect(h.loadZernioConfig).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('skips an account that does not use Zernio or a thread Zernio never saw', async () => {
    h.loadZernioConfig.mockResolvedValue(null)
    expect((await reportLeadConversion(db, INTAKE, { email: null }, AD)).status).toBe('skipped')
    h.loadZernioConfig.mockResolvedValue({ apiKey: 'sk_x', zernioAccountId: 'zacc' })
    h.convRow = { zernio_conversation_id: null }
    expect((await reportLeadConversion(db, INTAKE, { email: null }, AD)).status).toBe('skipped')
  })

  it('records Meta rejections as failed with the reason', async () => {
    h.send.mockResolvedValue({
      eventsReceived: 0,
      eventsFailed: 1,
      failures: [{ eventId: 'intake-1', message: 'Invalid event name' }],
      traceId: 'tr-2',
    })
    const out = await reportLeadConversion(db, INTAKE, { email: null }, AD)
    expect(out).toMatchObject({ status: 'failed', reason: 'Invalid event name', trace_id: 'tr-2' })
  })

  it('records an API error as failed instead of throwing', async () => {
    h.send.mockRejectedValue(new ZernioError('no ctwa_clid', 422, 'unprocessable'))
    const out = await reportLeadConversion(db, INTAKE, { email: null }, AD)
    expect(out.status).toBe('failed')
    expect(out.reason).toContain('422')
  })
})
