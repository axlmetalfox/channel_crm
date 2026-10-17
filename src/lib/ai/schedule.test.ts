import { describe, it, expect } from 'vitest'
import { isOnDuty, offDutySince, parseSchedule, type AutoReplySchedule } from './schedule'

// Intertec's agent hours: Mon–Thu 5:00pm → 7:30am, Fri 4:30pm → Mon 7:30am.
const INTERTEC: AutoReplySchedule = {
  timezone: 'America/Bogota',
  windows: [
    { days: [1, 2, 3, 4], start: '17:00', end: '07:30' },
    { days: [5], start: '16:30', end: '07:30' },
    { days: [6, 0], start: '00:00', end: '24:00' },
    { days: [1], start: '00:00', end: '07:30' },
  ],
}

/** A local Bogotá time (UTC-5, no DST) as a Date. 2026-10-12 is a Monday. */
const bogota = (day: number, hhmm: string) => {
  const date = `2026-10-${String(12 + day).padStart(2, '0')}`
  return new Date(`${date}T${hhmm}:00-05:00`)
}
// day offsets from Monday 12 Oct: Mon 0, Tue 1, Wed 2, Thu 3, Fri 4, Sat 5, Sun 6, next Mon 7

describe('isOnDuty', () => {
  it('is always on duty without a schedule', () => {
    expect(isOnDuty(null, new Date())).toBe(true)
  })

  it('is off during office hours Monday to Thursday', () => {
    for (const day of [0, 1, 2, 3]) {
      expect(isOnDuty(INTERTEC, bogota(day, '07:30'))).toBe(false)
      expect(isOnDuty(INTERTEC, bogota(day, '12:00'))).toBe(false)
      expect(isOnDuty(INTERTEC, bogota(day, '16:59'))).toBe(false)
    }
  })

  it('starts at 5:00pm Monday to Thursday and ends at 7:30am the next day', () => {
    for (const day of [0, 1, 2, 3]) {
      expect(isOnDuty(INTERTEC, bogota(day, '17:00'))).toBe(true)
      expect(isOnDuty(INTERTEC, bogota(day, '23:59'))).toBe(true)
      expect(isOnDuty(INTERTEC, bogota(day + 1, '00:00'))).toBe(true)
      expect(isOnDuty(INTERTEC, bogota(day + 1, '07:29'))).toBe(true)
      expect(isOnDuty(INTERTEC, bogota(day + 1, '07:30'))).toBe(false)
    }
  })

  it('on Friday it starts at 4:30pm and runs through the weekend to Monday 7:30am', () => {
    expect(isOnDuty(INTERTEC, bogota(4, '07:29'))).toBe(true) // Thursday night's window
    expect(isOnDuty(INTERTEC, bogota(4, '07:30'))).toBe(false)
    expect(isOnDuty(INTERTEC, bogota(4, '16:29'))).toBe(false)
    expect(isOnDuty(INTERTEC, bogota(4, '16:30'))).toBe(true)
    expect(isOnDuty(INTERTEC, bogota(5, '03:00'))).toBe(true)
    expect(isOnDuty(INTERTEC, bogota(5, '12:00'))).toBe(true) // Saturday
    expect(isOnDuty(INTERTEC, bogota(6, '12:00'))).toBe(true) // Sunday
    expect(isOnDuty(INTERTEC, bogota(7, '07:29'))).toBe(true) // Monday morning
    expect(isOnDuty(INTERTEC, bogota(7, '07:30'))).toBe(false)
  })

  it('reads the clock in the schedule\'s own time zone, not the server\'s', () => {
    // 20:00 UTC on a Wednesday is 15:00 in Bogotá: office hours.
    expect(isOnDuty(INTERTEC, new Date('2026-10-14T20:00:00Z'))).toBe(false)
    // 23:00 UTC is 18:00 in Bogotá: on duty.
    expect(isOnDuty(INTERTEC, new Date('2026-10-14T23:00:00Z'))).toBe(true)
  })
})

describe('offDutySince', () => {
  it('is when the working hours started', () => {
    // Wednesday 14:00 Bogotá: the AI went off duty at 07:30 the same day.
    expect(offDutySince(INTERTEC, bogota(2, '14:00'))?.toISOString()).toBe(bogota(2, '07:30').toISOString())
    // Monday 09:00: the AI went off duty at 07:30 that Monday, not the Friday before.
    expect(offDutySince(INTERTEC, bogota(7, '09:00'))?.toISOString()).toBe(bogota(7, '07:30').toISOString())
  })

  it('is null while the AI is on duty or when there is no schedule', () => {
    expect(offDutySince(INTERTEC, bogota(2, '20:00'))).toBeNull()
    expect(offDutySince(null, bogota(2, '14:00'))).toBeNull()
  })

  it('is null when the period began before the lookback', () => {
    expect(offDutySince(INTERTEC, bogota(2, '14:00'), 1)).toBeNull()
  })
})

describe('holidays', () => {
  const withHolidays: AutoReplySchedule = {
    ...INTERTEC,
    holidays: ['2026-11-02', '2026-12-08'],
  }
  // Monday 2 Nov 2026 is a holiday: the agent covers the whole day.
  const local = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`)

  it('covers a whole holiday, including the office hours', () => {
    expect(isOnDuty(withHolidays, local('2026-11-02', '09:00'))).toBe(true)
    expect(isOnDuty(withHolidays, local('2026-11-02', '12:30'))).toBe(true)
    expect(isOnDuty(withHolidays, local('2026-12-08', '10:00'))).toBe(true) // a Tuesday
  })

  it('is judged by the local date, not the UTC date', () => {
    // 23:30 on Sunday 1 Nov in Bogotá is already Monday 2 Nov in UTC.
    expect(isOnDuty(withHolidays, local('2026-11-01', '23:30'))).toBe(true)
    // Tuesday 3 Nov 09:00 is an ordinary working morning again.
    expect(isOnDuty(withHolidays, local('2026-11-03', '09:00'))).toBe(false)
    // Without the holiday list, the same Monday morning is office hours.
    expect(isOnDuty(INTERTEC, local('2026-11-02', '09:00'))).toBe(false)
  })
})

describe('parseSchedule', () => {
  it('keeps a valid holiday list, sorted and de-duplicated', () => {
    const parsed = parseSchedule({
      timezone: 'America/Bogota',
      windows: INTERTEC.windows,
      holidays: ['2026-12-25', '2026-11-02', '2026-11-02'],
    }) as AutoReplySchedule
    expect(parsed.holidays).toEqual(['2026-11-02', '2026-12-25'])
  })

  it('keeps and validates the office-hours tag name', () => {
    const base = { timezone: 'America/Bogota', windows: INTERTEC.windows }
    expect((parseSchedule({ ...base, officeHoursTag: ' Horario_laboral ' }) as AutoReplySchedule).officeHoursTag).toBe('Horario_laboral')
    expect(parseSchedule({ ...base, officeHoursTag: '' })).toMatch(/officeHoursTag/)
    expect(parseSchedule({ ...base, officeHoursTag: 5 })).toMatch(/officeHoursTag/)
  })

  it('rejects a malformed holiday list', () => {
    const base = { timezone: 'America/Bogota', windows: INTERTEC.windows }
    expect(parseSchedule({ ...base, holidays: ['02/11/2026'] })).toMatch(/holidays/)
    expect(parseSchedule({ ...base, holidays: ['2026-02-30'] })).toMatch(/holidays/)
    expect(parseSchedule({ ...base, holidays: 'x' })).toMatch(/holidays/)
  })

  it('accepts the Intertec schedule and null', () => {
    expect(parseSchedule(INTERTEC)).toEqual(INTERTEC)
    expect(parseSchedule(null)).toBeNull()
    expect(parseSchedule(undefined)).toBeNull()
  })

  it('rejects malformed schedules with a reason', () => {
    expect(typeof parseSchedule('x')).toBe('string')
    expect(parseSchedule({ timezone: 'Mars/Base', windows: INTERTEC.windows })).toMatch(/time zone/)
    expect(parseSchedule({ timezone: 'America/Bogota', windows: [] })).toMatch(/windows/)
    expect(
      parseSchedule({ timezone: 'America/Bogota', windows: [{ days: [7], start: '09:00', end: '10:00' }] }),
    ).toMatch(/days/)
    expect(
      parseSchedule({ timezone: 'America/Bogota', windows: [{ days: [1], start: '9am', end: '10:00' }] }),
    ).toMatch(/start/)
    expect(
      parseSchedule({ timezone: 'America/Bogota', windows: [{ days: [1], start: '09:00', end: '25:00' }] }),
    ).toMatch(/end/)
  })
})
