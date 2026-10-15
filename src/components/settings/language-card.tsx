'use client'

import { Languages } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { LOCALE_COOKIE, LOCALE_LABELS, SUPPORTED_LOCALES, type AppLocale } from '@/i18n/locale'
import { cn } from '@/lib/utils'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

function saveLocale(locale: AppLocale) {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`
}

/**
 * Language picker. The choice is stored in a cookie on this device (like
 * the appearance settings) and applied on the next render, so it takes
 * effect immediately after a refresh of the server components.
 */
export function LanguageCard() {
  const t = useTranslations('Settings.appearance')
  const active = useLocale() as AppLocale
  const router = useRouter()

  const pick = (locale: AppLocale) => {
    if (locale === active) return
    saveLocale(locale)
    router.refresh()
  }

  return (
    <div className="mt-8 space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Languages className="size-4 text-muted-foreground" />
        {t('language')}
      </h3>
      <p className="max-w-md text-xs text-muted-foreground">{t('languageDesc')}</p>
      <div role="radiogroup" aria-label={t('language')} className="grid max-w-md grid-cols-3 gap-3">
        {SUPPORTED_LOCALES.map((locale) => {
          const isActive = locale === active
          return (
            <button
              key={locale}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => pick(locale)}
              className={cn(
                'rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {LOCALE_LABELS[locale]}
            </button>
          )
        })}
      </div>
    </div>
  )
}
