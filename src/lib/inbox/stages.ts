import type { ConversationStage, StageTrigger } from '@/types'

/** The events a stage can be tied to, in the order a chat goes through them. */
export const STAGE_TRIGGERS: StageTrigger[] = ['ai_answering', 'advisor_assigned', 'lead_sent']

export function isStageTrigger(value: unknown): value is StageTrigger {
  return typeof value === 'string' && (STAGE_TRIGGERS as string[]).includes(value)
}

/** Colors offered when creating a stage (same palette as tags). */
export const STAGE_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const

export const STAGE_NAME_MAX = 40

/** Stages in the order the account arranged them. */
export function sortStages(stages: ConversationStage[]): ConversationStage[] {
  return [...stages].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
}

/** Position for a stage added at the end of the list. */
export function nextStagePosition(stages: Pick<ConversationStage, 'position'>[]): number {
  return stages.reduce((max, s) => Math.max(max, s.position), -1) + 1
}

/**
 * The new positions after moving one stage a step up or down: every stage
 * gets its index in the list (so gaps and ties are tidied too). Returns null
 * when the move is not possible (already first/last, or unknown id).
 */
export function moveStage(
  stages: ConversationStage[],
  id: string,
  direction: 'up' | 'down',
): { id: string; position: number }[] | null {
  const ordered = sortStages(stages)
  const index = ordered.findIndex((s) => s.id === id)
  const target = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= ordered.length) return null
  const next = [...ordered]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next.map((s, i) => ({ id: s.id, position: i }))
}

/** A name worth saving: trimmed, not empty, not longer than the limit. */
export function cleanStageName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim()
  return name.length > 0 && name.length <= STAGE_NAME_MAX ? name : null
}

/** Whether another stage already uses this name (case-insensitive). */
export function stageNameTaken(
  stages: Pick<ConversationStage, 'id' | 'name'>[],
  name: string,
  exceptId?: string,
): boolean {
  const key = name.trim().toLowerCase()
  return stages.some((s) => s.id !== exceptId && s.name.trim().toLowerCase() === key)
}
