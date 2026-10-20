import { describe, it, expect } from 'vitest'
import type { ConversationStage } from '@/types'
import { cleanStageName, moveStage, nextStagePosition, sortStages, stageNameTaken } from './stages'

const stage = (id: string, name: string, position: number): ConversationStage => ({
  id,
  account_id: 'a',
  name,
  color: '#000',
  position,
})

const list = [stage('b', 'Beta', 1), stage('a', 'Alfa', 0), stage('c', 'Gama', 2)]

describe('sortStages', () => {
  it('orders by position, then name', () => {
    expect(sortStages(list).map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(sortStages([stage('x', 'Zeta', 0), stage('y', 'Beta', 0)]).map((s) => s.id)).toEqual(['y', 'x'])
  })
})

describe('nextStagePosition', () => {
  it('goes after the last one, and starts at 0', () => {
    expect(nextStagePosition(list)).toBe(3)
    expect(nextStagePosition([])).toBe(0)
  })
})

describe('moveStage', () => {
  it('swaps with the neighbour and renumbers from 0', () => {
    expect(moveStage(list, 'b', 'up')).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
      { id: 'c', position: 2 },
    ])
    expect(moveStage(list, 'b', 'down')).toEqual([
      { id: 'a', position: 0 },
      { id: 'c', position: 1 },
      { id: 'b', position: 2 },
    ])
  })

  it('refuses to move past the ends or an unknown stage', () => {
    expect(moveStage(list, 'a', 'up')).toBeNull()
    expect(moveStage(list, 'c', 'down')).toBeNull()
    expect(moveStage(list, 'zzz', 'up')).toBeNull()
  })
})

describe('cleanStageName / stageNameTaken', () => {
  it('trims, collapses spaces and enforces the limit', () => {
    expect(cleanStageName('  Asesor   Comercial  ')).toBe('Asesor Comercial')
    expect(cleanStageName('   ')).toBeNull()
    expect(cleanStageName('x'.repeat(41))).toBeNull()
  })

  it('detects a repeated name regardless of case, except for the stage itself', () => {
    expect(stageNameTaken(list, ' ALFA ')).toBe(true)
    expect(stageNameTaken(list, 'alfa', 'a')).toBe(false)
    expect(stageNameTaken(list, 'Delta')).toBe(false)
  })
})
