// ============================================================
// Fixed replies for what the AI agent cannot or should not answer.
// An account can override either one (ai_configs.non_text_reply /
// reply_limit_reply); otherwise these defaults apply.
// ============================================================

export type FallbackKind = 'nonText' | 'replyLimit'

const DEFAULTS: Record<FallbackKind, { es: string; en: string }> = {
  nonText: {
    es: 'Por ahora solo puedo leer mensajes de texto. ¿Me lo puedes escribir, por favor?',
    en: 'For now I can only read text messages. Could you type it for me, please?',
  },
  replyLimit: {
    es: 'Hemos alcanzado el límite de mensajes de esta conversación automática. Si quieres continuar, escríbenos de nuevo más tarde y te atenderemos con gusto.',
    en: 'We have reached the message limit of this automated conversation. If you want to continue, write to us again later and we will gladly help.',
  },
}

/** The language the built-in defaults use: the deployment default. */
function defaultLanguage(): 'es' | 'en' {
  const raw = process.env.APP_DEFAULT_LOCALE || process.env.NEXT_PUBLIC_APP_LOCALE
  return raw === 'es' ? 'es' : 'en'
}

/** The account's own text when it set one, else the built-in default. */
export function fallbackText(kind: FallbackKind, custom: string | null | undefined): string {
  const own = custom?.trim()
  return own ? own : DEFAULTS[kind][defaultLanguage()]
}
