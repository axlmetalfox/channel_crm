import { describe, it, expect } from 'vitest'
import { zohoLeadIdFrom } from './zoho-id'

describe('zohoLeadIdFrom', () => {
  it('reads the id the CRM bridge answered with', () => {
    expect(zohoLeadIdFrom([{ ok: true, action: 'create', zoho_lead_id: '4634243000153062002' }])).toBe('4634243000153062002')
    expect(zohoLeadIdFrom([[{ zoho_lead_id: ' 4634243000153062002 ' }]])).toBe('4634243000153062002')
    expect(zohoLeadIdFrom([{ zoho_lead_id: 4634243000153062 }])).toBe('4634243000153062')
  })

  it('ignores anything that is not an id', () => {
    expect(zohoLeadIdFrom(undefined)).toBeNull()
    expect(zohoLeadIdFrom([])).toBeNull()
    expect(zohoLeadIdFrom([{ ok: true }])).toBeNull()
    expect(zohoLeadIdFrom([{ zoho_lead_id: 'abc' }, 'text', null])).toBeNull()
  })
})
