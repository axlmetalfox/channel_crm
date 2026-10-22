// ============================================================
// Minimal Zernio REST client — only what the WhatsApp channel needs:
//   - send a text message into a conversation (24h window)
//   - check that an API key + connected account work
//   - register our webhook endpoint
//
// Docs: https://docs.zernio.com (base https://zernio.com/api/v1, bearer
// API key). Errors surface as `ZernioError` with the HTTP status so
// callers can tell a bad key (401) from an unknown account (404).
// ============================================================

export const ZERNIO_DEFAULT_BASE_URL = 'https://zernio.com/api/v1'
const REQUEST_TIMEOUT_MS = 20_000

export class ZernioError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'ZernioError'
    this.status = status
    this.code = code
  }
}

/**
 * API root without a trailing slash. Override with `ZERNIO_API_BASE`
 * (operator-controlled, https only — the bearer key is sent there).
 */
export function zernioBaseUrl(): string {
  const raw = process.env.ZERNIO_API_BASE?.trim()
  if (!raw) return ZERNIO_DEFAULT_BASE_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ZernioError('ZERNIO_API_BASE is not a valid URL.', 500)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ZernioError('ZERNIO_API_BASE must be a plain https URL.', 500)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

interface RequestOpts {
  apiKey: string
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: unknown
  idempotencyKey?: string
}

async function zernioRequest<T>(opts: RequestOpts): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    Accept: 'application/json',
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  let res: Response
  try {
    res = await fetch(`${zernioBaseUrl()}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
    throw new ZernioError(
      timedOut ? 'Zernio took too long to respond.' : 'Could not reach Zernio.',
      timedOut ? 504 : 502,
    )
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const message =
      (typeof data?.error === 'string' && data.error) ||
      (typeof data?.message === 'string' && data.message) ||
      `Zernio API error (${res.status})`
    throw new ZernioError(
      message,
      res.status,
      typeof data?.code === 'string' ? data.code : null,
    )
  }
  return (data ?? {}) as T
}

/**
 * Send a plain text message into an existing Zernio conversation.
 * Only valid inside the 24h window after the customer's last message,
 * which is always the case for a reply to an inbound message.
 * Returns Zernio's message id.
 */
export async function sendZernioText(args: {
  apiKey: string
  accountId: string
  conversationId: string
  text: string
  idempotencyKey?: string
}): Promise<{ messageId: string }> {
  const res = await zernioRequest<{ data?: { messageId?: string } }>({
    apiKey: args.apiKey,
    method: 'POST',
    path: `/inbox/conversations/${encodeURIComponent(args.conversationId)}/messages`,
    body: { accountId: args.accountId, message: args.text },
    idempotencyKey: args.idempotencyKey,
  })
  const messageId = res.data?.messageId
  if (!messageId) {
    throw new ZernioError('Zernio accepted the message but returned no id.', 502)
  }
  return { messageId }
}

/**
 * Send a file (photo, video, audio, document) into a Zernio conversation.
 * `attachmentUrl` must be publicly reachable: Zernio downloads it. The
 * optional text becomes the caption. Returns Zernio's message id.
 */
export async function sendZernioAttachment(args: {
  apiKey: string
  accountId: string
  conversationId: string
  attachmentUrl: string
  attachmentType: 'image' | 'video' | 'audio' | 'file'
  /** Caption (image, video, document). */
  text?: string | null
  /** Document file name shown to the recipient. */
  attachmentName?: string | null
  /** Audio only: send as a WhatsApp voice note (needs .ogg / Opus). */
  voiceNote?: boolean
  idempotencyKey?: string
}): Promise<{ messageId: string }> {
  const res = await zernioRequest<{ data?: { messageId?: string } }>({
    apiKey: args.apiKey,
    method: 'POST',
    path: `/inbox/conversations/${encodeURIComponent(args.conversationId)}/messages`,
    body: {
      accountId: args.accountId,
      attachmentUrl: args.attachmentUrl,
      attachmentType: args.attachmentType,
      ...(args.text ? { message: args.text } : {}),
      ...(args.attachmentType === 'file' && args.attachmentName ? { attachmentName: args.attachmentName } : {}),
      ...(args.attachmentType === 'audio' && args.voiceNote ? { voiceNote: true } : {}),
    },
    idempotencyKey: args.idempotencyKey,
  })
  const messageId = res.data?.messageId
  if (!messageId) {
    throw new ZernioError('Zernio accepted the message but returned no id.', 502)
  }
  return { messageId }
}

export interface WhatsAppBlockResult {
  /** Users WhatsApp accepted. */
  done: string[]
  /** Users it refused, with Meta's reasons (e.g. "Re-engagement required"
   *  when the person has not written in the last 24 hours). */
  failed: { input: string; errors: string[] }[]
}

/**
 * Block or unblock WhatsApp users on the connected number. Blocked people
 * cannot message the number and see no online status; sends to them fail.
 * Meta only blocks people who wrote in the last 24 hours. `users` are
 * E.164 numbers ("+573001234567") or WhatsApp user ids. The request itself
 * succeeds even when some users fail: read `failed`.
 */
export async function setWhatsAppBlock(args: {
  apiKey: string
  accountId: string
  users: string[]
  block: boolean
}): Promise<WhatsAppBlockResult> {
  const res = await zernioRequest<{
    blocked?: { input: string }[]
    unblocked?: { input: string }[]
    failed?: { input: string; errors?: string[] }[]
  }>({
    apiKey: args.apiKey,
    method: args.block ? 'POST' : 'DELETE',
    path: '/whatsapp/block-users',
    body: { accountId: args.accountId, users: args.users },
  })
  return {
    done: (args.block ? res.blocked : res.unblocked)?.map((u) => u.input) ?? [],
    failed: (res.failed ?? []).map((f) => ({ input: f.input, errors: f.errors ?? [] })),
  }
}

/** A WhatsApp message template as Zernio reads it from Meta. */
export interface ZernioTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: {
    type: string
    text?: string
    format?: string
    buttons?: { type: string; text: string; url?: string; phone_number?: string; example?: string[] | string }[]
    example?: { header_text?: string[]; header_handle?: string[]; body_text?: string[][] }
  }[]
}

/** Every template of the connected WhatsApp account (one entry per name + language). */
export async function listZernioTemplates(args: {
  apiKey: string
  accountId: string
}): Promise<ZernioTemplate[]> {
  const res = await zernioRequest<{ templates?: ZernioTemplate[] }>({
    apiKey: args.apiKey,
    method: 'GET',
    path: `/whatsapp/templates?accountId=${encodeURIComponent(args.accountId)}`,
  })
  return res.templates ?? []
}

/**
 * Send an approved template inside a conversation the customer already has
 * with us (Zernio keeps the thread). `bodyParams` fill {{1}}, {{2}}… in order.
 */
export async function sendZernioTemplate(args: {
  apiKey: string
  accountId: string
  conversationId: string
  name: string
  language: string
  bodyParams: string[]
  idempotencyKey?: string
}): Promise<{ messageId: string }> {
  const res = await zernioRequest<{ data?: { messageId?: string } }>({
    apiKey: args.apiKey,
    method: 'POST',
    path: `/inbox/conversations/${encodeURIComponent(args.conversationId)}/messages`,
    body: {
      accountId: args.accountId,
      template: {
        elements: [
          {
            name: args.name,
            language: args.language,
            ...(args.bodyParams.length
              ? {
                  components: [
                    {
                      type: 'body',
                      parameters: args.bodyParams.map((text) => ({ type: 'text', text })),
                    },
                  ],
                }
              : {}),
          },
        ],
      },
    },
    idempotencyKey: args.idempotencyKey,
  })
  const messageId = res.data?.messageId
  if (!messageId) {
    throw new ZernioError('Zernio accepted the template but returned no id.', 502)
  }
  return { messageId }
}

/**
 * Open a conversation with a phone number that has no thread yet, by sending
 * an approved template (the only thing WhatsApp allows outside the 24h
 * window). `participantId` is digits with country code, no "+". Returns the
 * new Zernio conversation id plus the message id.
 */
export async function startZernioConversation(args: {
  apiKey: string
  accountId: string
  phone: string
  name: string
  language: string
  bodyParams: string[]
  idempotencyKey?: string
}): Promise<{ messageId: string; conversationId: string }> {
  const res = await zernioRequest<{ data?: { messageId?: string; conversationId?: string } }>({
    apiKey: args.apiKey,
    method: 'POST',
    path: '/inbox/conversations',
    body: {
      accountId: args.accountId,
      participantId: args.phone.replace(/\D/g, ''),
      templateName: args.name,
      templateLanguage: args.language,
      templateParams: args.bodyParams,
    },
    idempotencyKey: args.idempotencyKey,
  })
  const messageId = res.data?.messageId
  const conversationId = res.data?.conversationId
  if (!messageId || !conversationId) {
    throw new ZernioError('Zernio accepted the template but returned no conversation.', 502)
  }
  return { messageId, conversationId }
}

export interface WhatsAppNumberStatus {
  /** Meta's connection status of the number, e.g. CONNECTED / DISCONNECTED. */
  phoneStatus: string | null
  platformType: string | null
  quality: string | null
  tier: string | null
  displayPhone: string | null
}

/** Live status of the connected WhatsApp number, straight from Meta (read-only). */
export async function getWhatsAppNumberStatus(args: {
  apiKey: string
  accountId: string
}): Promise<WhatsAppNumberStatus> {
  const res = await zernioRequest<{ phone?: Record<string, unknown> }>({
    apiKey: args.apiKey,
    method: 'GET',
    path: `/whatsapp/number-info?accountId=${encodeURIComponent(args.accountId)}`,
  })
  const p = res.phone ?? {}
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    phoneStatus: str(p.status),
    platformType: str(p.platform_type),
    quality: str(p.quality_rating),
    tier: str(p.messaging_limit_tier),
    displayPhone: str(p.display_phone_number),
  }
}

export interface ZernioAccountHealth {
  accountId: string
  platform: string | null
  username: string | null
  status: string | null
  /** WhatsApp only: whether Meta is delivering inbound messages to Zernio. */
  inboundWebhookSubscribed: boolean | null
  connection: string | null
}

/** Validate the API key and the connected account id (GET …/health). */
export async function checkZernioAccount(
  apiKey: string,
  accountId: string,
): Promise<ZernioAccountHealth> {
  const res = await zernioRequest<Record<string, unknown>>({
    apiKey,
    method: 'GET',
    path: `/accounts/${encodeURIComponent(accountId)}/health`,
  })
  const conn = (res.platformConnection ?? {}) as Record<string, unknown>
  return {
    accountId: String(res.accountId ?? accountId),
    platform: typeof res.platform === 'string' ? res.platform : null,
    username: typeof res.username === 'string' ? res.username : null,
    status: typeof res.status === 'string' ? res.status : null,
    inboundWebhookSubscribed:
      typeof conn.inboundWebhookSubscribed === 'boolean'
        ? conn.inboundWebhookSubscribed
        : null,
    connection: typeof conn.status === 'string' ? conn.status : null,
  }
}

/** The WABA's Meta conversions dataset id, or null when not set up yet. */
export async function getWhatsAppDataset(args: {
  apiKey: string
  accountId: string
}): Promise<{ datasetId: string | null }> {
  const res = await zernioRequest<Record<string, unknown>>({
    apiKey: args.apiKey,
    method: 'GET',
    path: `/whatsapp/dataset?accountId=${encodeURIComponent(args.accountId)}`,
  })
  return { datasetId: typeof res.datasetId === 'string' ? res.datasetId : null }
}

/** Create (or find) the WABA's Meta conversions dataset. Idempotent. */
export async function provisionWhatsAppDataset(args: {
  apiKey: string
  accountId: string
}): Promise<{ datasetId: string | null; created: boolean }> {
  const res = await zernioRequest<Record<string, unknown>>({
    apiKey: args.apiKey,
    method: 'POST',
    path: '/whatsapp/dataset',
    body: { accountId: args.accountId },
  })
  return {
    datasetId: typeof res.datasetId === 'string' ? res.datasetId : null,
    created: res.created === true,
  }
}

export interface WhatsAppConversionResult {
  eventsReceived: number
  eventsFailed: number
  failures: { eventId: string | null; message: string }[]
  traceId: string | null
}

/**
 * Report a conversion for a chat that started from a click-to-WhatsApp
 * ad. The 200 only means the request reached Meta: the counts say whether
 * Meta took the event.
 */
export async function sendWhatsAppConversion(args: {
  apiKey: string
  accountId: string
  conversationId: string
  eventName: 'LeadSubmitted'
  /** Stable dedup key. */
  eventId: string
  /** Unix seconds. */
  eventTime?: number
  email?: string | null
  /** Meta's test_event_code: routes the event to Test Events. */
  testCode?: string
}): Promise<WhatsAppConversionResult> {
  const res = await zernioRequest<Record<string, unknown>>({
    apiKey: args.apiKey,
    method: 'POST',
    path: '/whatsapp/conversions',
    body: {
      accountId: args.accountId,
      conversationId: args.conversationId,
      eventName: args.eventName,
      eventId: args.eventId,
      ...(args.eventTime ? { eventTime: args.eventTime } : {}),
      ...(args.email ? { email: args.email } : {}),
      ...(args.testCode ? { testCode: args.testCode } : {}),
    },
  })
  const failures = Array.isArray(res.failures) ? res.failures : []
  return {
    eventsReceived: typeof res.eventsReceived === 'number' ? res.eventsReceived : 0,
    eventsFailed: typeof res.eventsFailed === 'number' ? res.eventsFailed : 0,
    failures: failures.map((f) => {
      const o = (f ?? {}) as Record<string, unknown>
      return {
        eventId: typeof o.eventId === 'string' ? o.eventId : null,
        message: typeof o.message === 'string' ? o.message : 'rejected',
      }
    }),
    traceId: typeof res.traceId === 'string' ? res.traceId : null,
  }
}

/** Events wacrm consumes from Zernio's inbox. */
export const ZERNIO_WEBHOOK_EVENTS = [
  'message.received',
  'message.delivered',
  'message.read',
  'message.failed',
] as const

/**
 * Register our webhook endpoint at Zernio, scoped to one account. We
 * choose the signing secret (Zernio does not generate one). Returns the
 * endpoint id when Zernio reports it.
 */
export async function registerZernioWebhook(args: {
  apiKey: string
  name: string
  url: string
  secret: string
  accountId: string
}): Promise<{ id: string | null }> {
  const res = await zernioRequest<Record<string, unknown>>({
    apiKey: args.apiKey,
    method: 'POST',
    path: '/webhooks/settings',
    body: {
      name: args.name,
      url: args.url,
      events: [...ZERNIO_WEBHOOK_EVENTS],
      secret: args.secret,
      accountIds: [args.accountId],
    },
  })
  const data = (res.data ?? res.webhook ?? res) as Record<string, unknown>
  const id = data.id ?? data._id ?? data.webhookId
  return { id: typeof id === 'string' ? id : null }
}
