import { describe, it, expect } from 'vitest'
import type { ZernioConnection } from '@/lib/zernio/client'
import { PROVIDERS, profileForNewConnection, stateFromConnections } from './providers'

const conn = (over: Partial<ZernioConnection>): ZernioConnection => ({
  id: 'c1',
  platform: 'metaads',
  username: 'Intertec',
  displayName: null,
  profileId: 'p1',
  enabled: true,
  isActive: true,
  needsReconnection: false,
  createdAt: null,
  parentAccountId: null,
  ...over,
})

const META = PROVIDERS.find((p) => p.id === 'meta')!
const GOOGLE = PROVIDERS.find((p) => p.id === 'google')!

describe('stateFromConnections', () => {
  it('is connected when a healthy connection of the platform exists', () => {
    expect(stateFromConnections(META, [conn({})]).state).toBe('connected')
  })

  it('is not connected when there is none, or only other platforms', () => {
    expect(stateFromConnections(META, []).state).toBe('not_connected')
    expect(stateFromConnections(META, [conn({ platform: 'whatsapp' })]).state).toBe('not_connected')
    expect(stateFromConnections(META, [conn({ enabled: false })]).state).toBe('not_connected')
  })

  it('asks for a new sign-in when the access expired or was revoked', () => {
    expect(stateFromConnections(META, [conn({ needsReconnection: true })]).state).toBe('needs_reconnect')
    expect(stateFromConnections(META, [conn({ isActive: false })]).state).toBe('needs_reconnect')
  })

  it('a healthy connection wins over a broken one', () => {
    const r = stateFromConnections(META, [conn({ id: 'bad', needsReconnection: true }), conn({ id: 'good' })])
    expect(r.state).toBe('connected')
    expect(r.connection?.id).toBe('good')
  })

  it('providers without a flow yet are coming soon', () => {
    expect(stateFromConnections(GOOGLE, [conn({ platform: 'googleads' })]).state).toBe('coming_soon')
    expect(PROVIDERS.find((p) => p.id === 'openai')?.available).toBe(false)
  })
})

describe('profileForNewConnection', () => {
  it('reuses the profile the existing connections belong to', () => {
    expect(profileForNewConnection([conn({ profileId: null }), conn({ profileId: 'p9' })])).toBe('p9')
    expect(profileForNewConnection([])).toBeNull()
  })
})
