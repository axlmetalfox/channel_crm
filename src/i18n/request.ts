import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { LOCALE_COOKIE, resolveLocale } from './locale'

export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()])

  // Saved choice > browser language > deployment default > English.
  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get('accept-language'),
    envDefault: process.env.NEXT_PUBLIC_APP_LOCALE,
  })

  let messages
  try {
    messages = (await import(`../../messages/${locale}.json`)).default
  } catch {
    // Fallback to English if the dictionary for the locale is missing.
    messages = (await import(`../../messages/en.json`)).default
  }

  return { locale, messages }
})
