import { describe, it, expect } from 'vitest'
import { CONFIRM_AFTER, nextHealth, observeChannel, type HealthState } from './health'

const UP: HealthState = { status: 'connected', failCount: 0, downSince: null, alertedAt: null }
const T1 = '2026-10-22T13:00:00.000Z'
const T2 = '2026-10-22T13:05:00.000Z'
const T3 = '2026-10-22T13:10:00.000Z'

describe('observeChannel', () => {
  it('reads a healthy number', () => {
    expect(observeChannel('CONNECTED', true)).toEqual({ observed: 'connected', detail: 'CONNECTED' })
    expect(observeChannel('connected', null).observed).toBe('connected')
  })

  it('reads anything else as disconnected, with the reason', () => {
    expect(observeChannel('DISCONNECTED', true)).toEqual({ observed: 'disconnected', detail: 'DISCONNECTED' })
    expect(observeChannel('PENDING', null).observed).toBe('disconnected')
  })

  it('treats a connected number whose inbound webhook is not subscribed as down', () => {
    expect(observeChannel('CONNECTED', false)).toEqual({ observed: 'disconnected', detail: 'INBOUND_WEBHOOK_NOT_SUBSCRIBED' })
  })

  it('does not judge what it could not read', () => {
    expect(observeChannel(null, true).observed).toBe('unknown')
    expect(observeChannel('', null).observed).toBe('unknown')
  })
})

describe('nextHealth', () => {
  it('ignores a single bad reading', () => {
    const { state, alert } = nextHealth(UP, 'disconnected', T1)
    expect(alert).toBeNull()
    expect(state).toMatchObject({ status: 'connected', failCount: 1, downSince: T1, alertedAt: null })
  })

  it('declares the outage after the confirming reading, once, with the time it began', () => {
    expect(CONFIRM_AFTER).toBe(2)
    const first = nextHealth(UP, 'disconnected', T1).state
    const second = nextHealth(first, 'disconnected', T2)
    expect(second.alert).toBe('down')
    expect(second.state).toMatchObject({ status: 'disconnected', failCount: 2, downSince: T1, alertedAt: T2 })

    const third = nextHealth(second.state, 'disconnected', T3)
    expect(third.alert).toBeNull()
    expect(third.state).toMatchObject({ status: 'disconnected', downSince: T1, alertedAt: T2 })
  })

  it('a good reading in between cancels a suspected outage', () => {
    const suspected = nextHealth(UP, 'disconnected', T1).state
    const { state, alert } = nextHealth(suspected, 'connected', T2)
    expect(alert).toBeNull()
    expect(state).toEqual(UP)
  })

  it('says when the number is back, once', () => {
    const down = nextHealth(nextHealth(UP, 'disconnected', T1).state, 'disconnected', T2).state
    const back = nextHealth(down, 'connected', T3)
    expect(back.alert).toBe('restored')
    expect(back.state).toEqual(UP)
    expect(nextHealth(back.state, 'connected', T3).alert).toBeNull()
  })

  it('an unreadable reading changes nothing', () => {
    const down = nextHealth(nextHealth(UP, 'disconnected', T1).state, 'disconnected', T2).state
    expect(nextHealth(down, 'unknown', T3)).toEqual({ state: down, alert: null })
    expect(nextHealth(UP, 'unknown', T3)).toEqual({ state: UP, alert: null })
  })
})
