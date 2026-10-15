import { enUS, es, ko, type Locale } from 'date-fns/locale'

const LOCALES: Record<string, Locale> = { en: enUS, es, ko }

/** date-fns locale for an app locale code (falls back to English). */
export function dateFnsLocale(code: string): Locale {
  return LOCALES[code] ?? enUS
}
