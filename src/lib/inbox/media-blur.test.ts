import { describe, it, expect } from 'vitest'
import { hasHumanReply, isMediaBlurred } from './media-blur'

const photo = { id: 'm1', sender_type: 'customer' as const, content_type: 'image' as const, ai_flag: null }
const none = new Set<string>()

describe('isMediaBlurred', () => {
  it('blurs a customer photo while nobody on the team has answered', () => {
    expect(isMediaBlurred(photo, { humanReplied: false, revealed: none })).toBe(true)
  })

  it('shows it once a colleague has replied', () => {
    expect(isMediaBlurred(photo, { humanReplied: true, revealed: none })).toBe(false)
  })

  it('always blurs a flagged file, even after a reply', () => {
    expect(isMediaBlurred({ ...photo, ai_flag: 'offensive' }, { humanReplied: true, revealed: none })).toBe(true)
  })

  it('lets a click reveal one file', () => {
    expect(isMediaBlurred({ ...photo, ai_flag: 'offensive' }, { humanReplied: false, revealed: new Set(['m1']) })).toBe(false)
  })

  it('never blurs our own media or non-media messages', () => {
    expect(isMediaBlurred({ ...photo, sender_type: 'agent' as never }, { humanReplied: false, revealed: none })).toBe(false)
    expect(isMediaBlurred({ ...photo, content_type: 'text' as never }, { humanReplied: false, revealed: none })).toBe(false)
    expect(isMediaBlurred({ ...photo, content_type: 'audio' as never }, { humanReplied: false, revealed: none })).toBe(false)
  })
})

describe('hasHumanReply', () => {
  it('counts agents, not the AI bot or the customer', () => {
    expect(hasHumanReply([{ sender_type: 'customer' }, { sender_type: 'bot' }])).toBe(false)
    expect(hasHumanReply([{ sender_type: 'customer' }, { sender_type: 'agent' }])).toBe(true)
  })
})
