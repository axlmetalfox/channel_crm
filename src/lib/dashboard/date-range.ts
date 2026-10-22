import { daysAgoStart, localDayKey } from './date-utils'

export type Preset = 'today' | 'yesterday' | '7' | '30' | 'month'

export const PRESETS: Preset[] = ['today', 'yesterday', '7', '30', 'month']

/** Inclusive local-day range (YYYY-MM-DD) for a quick preset. */
export function presetRange(preset: Preset): { from: string; to: string } {
  const today = localDayKey(new Date())
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = localDayKey(daysAgoStart(1))
      return { from: y, to: y }
    }
    case '7':
      return { from: localDayKey(daysAgoStart(6)), to: today }
    case '30':
      return { from: localDayKey(daysAgoStart(29)), to: today }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today }
  }
}
