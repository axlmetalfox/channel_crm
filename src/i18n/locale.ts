// Locale selection. Pure so it can be tested and imported from client
// components; the cookie / header reads live in request.ts.

export const SUPPORTED_LOCALES = ['es', 'en', 'ko'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]

/** Native names, shown in the language picker. */
export const LOCALE_LABELS: Record<AppLocale, string> = {
  es: 'Español',
  en: 'English',
  ko: '한국어',
}

/** Per-device language choice (set by the picker in Settings → Appearance). */
export const LOCALE_COOKIE = 'tuyo_locale'

export function isSupportedLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * First supported language in an `Accept-Language` header, honouring the
 * browser's own ranking (`es-CO,es;q=0.9,en;q=0.8` → `es`).
 */
export function fromAcceptLanguage(header: string | null | undefined): AppLocale | null {
  if (!header) return null
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';')
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
      const weight = q ? Number(q.slice(2)) : 1
      return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index }
    })
    .filter((l) => l.tag && l.tag !== '*' && l.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)

  for (const { tag } of ranked) {
    const base = tag.split('-')[0]
    if (isSupportedLocale(base)) return base
  }
  return null
}

/**
 * The language to render in: the user's saved choice, else what their
 * browser asks for, else the deployment default (`NEXT_PUBLIC_APP_LOCALE`),
 * else English.
 */
export function resolveLocale(args: {
  cookie?: string | null
  acceptLanguage?: string | null
  envDefault?: string | null
}): AppLocale {
  if (isSupportedLocale(args.cookie)) return args.cookie
  const fromBrowser = fromAcceptLanguage(args.acceptLanguage)
  if (fromBrowser) return fromBrowser
  if (isSupportedLocale(args.envDefault)) return args.envDefault
  return 'en'
}
