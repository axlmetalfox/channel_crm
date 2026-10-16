// ============================================================
// When the AI agent is on duty.
//
// A business that answers its own chats during office hours can have
// the agent cover only the rest. The schedule is a list of weekly
// windows in one time zone; outside every window the agent stays silent
// (the message waits for a person). No schedule = always on duty.
//
//   { "timezone": "America/Bogota",
//     "windows": [
//       { "days": [1, 2, 3, 4], "start": "17:00", "end": "07:30" },
//       { "days": [5],          "start": "16:30", "end": "07:30" },
//       { "days": [6, 0],       "start": "00:00", "end": "24:00" },
//       { "days": [1],          "start": "00:00", "end": "07:30" } ] }
//
// days: 0 = Sunday … 6 = Saturday. A window whose end is not after its
// start runs overnight into the next day (Mon 17:00 → Tue 07:30).
// "24:00" means the end of the day.
//
// holidays: local dates ("YYYY-MM-DD") on which the business is closed,
// so the agent answers all day regardless of the windows.
// ============================================================

export interface ScheduleWindow {
  days: number[]
  /** "HH:MM" local time. */
  start: string
  /** "HH:MM" local time; "24:00" = midnight at the end of the day. */
  end: string
}

export interface AutoReplySchedule {
  /** IANA time zone, e.g. "America/Bogota". */
  timezone: string
  windows: ScheduleWindow[]
  /** Local dates ("YYYY-MM-DD") when the agent covers the whole day. */
  holidays?: string[]
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Validate untrusted input (the settings API or a DB value). Returns the
 * schedule, `null` for "no schedule" (null/undefined), or a string with
 * the reason it is invalid.
 */
export function parseSchedule(raw: unknown): AutoReplySchedule | null | string {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'schedule must be an object'
  const r = raw as Record<string, unknown>
  if (typeof r.timezone !== 'string' || !validTimeZone(r.timezone)) {
    return 'schedule.timezone must be a valid IANA time zone'
  }
  if (!Array.isArray(r.windows) || r.windows.length === 0 || r.windows.length > 20) {
    return 'schedule.windows must be a list of 1 to 20 windows'
  }
  let holidays: string[] | undefined
  if (r.holidays !== undefined && r.holidays !== null) {
    if (
      !Array.isArray(r.holidays) ||
      r.holidays.length > 400 ||
      !r.holidays.every(
        (d) =>
          typeof d === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(d) &&
          !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
          new Date(`${d}T00:00:00Z`).toISOString().startsWith(d),
      )
    ) {
      return 'schedule.holidays must be a list of dates as YYYY-MM-DD'
    }
    holidays = [...new Set(r.holidays as string[])].sort()
  }
  const windows: ScheduleWindow[] = []
  for (const w of r.windows) {
    if (!w || typeof w !== 'object') return 'each window must be an object'
    const { days, start, end } = w as Record<string, unknown>
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    ) {
      return 'window.days must be numbers from 0 (Sunday) to 6 (Saturday)'
    }
    if (typeof start !== 'string' || !TIME_RE.test(start) || start === '24:00') {
      return 'window.start must be HH:MM'
    }
    if (typeof end !== 'string' || !TIME_RE.test(end)) return 'window.end must be HH:MM'
    windows.push({ days: [...new Set(days as number[])], start, end })
  }
  return holidays ? { timezone: r.timezone, windows, holidays } : { timezone: r.timezone, windows }
}

/** Day of week (0-6), minutes since midnight and the date in `timezone`. */
function localClock(
  at: Date,
  timezone: string,
): { day: number; minute: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return {
    day,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

/** Whether the agent should answer at `at`. No schedule = always. */
export function isOnDuty(schedule: AutoReplySchedule | null, at: Date = new Date()): boolean {
  if (!schedule) return true
  const { day, minute, date } = localClock(at, schedule.timezone)
  if (schedule.holidays?.includes(date)) return true
  const prevDay = (day + 6) % 7
  for (const w of schedule.windows) {
    const start = minutes(w.start)
    const end = minutes(w.end)
    if (end > start) {
      if (w.days.includes(day) && minute >= start && minute < end) return true
    } else {
      // Overnight: the evening part belongs to this day, the morning part
      // to the window that started the day before.
      if (w.days.includes(day) && minute >= start) return true
      if (w.days.includes(prevDay) && minute < end) return true
    }
  }
  return false
}
