// ============================================================
// Parse Zernio inbox webhook payloads into the two shapes wacrm acts
// on. Deliberately tolerant: Zernio documents field names but ships no
// full JSON samples, so every read is guarded and anything we cannot
// make sense of returns null (the route acknowledges and ignores it).
// ============================================================

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

export interface ZernioInbound {
  kind: 'message'
  /** Stable event id (also the X-Zernio-Event-Id header). */
  eventId: string | null
  /** Zernio's message id — what we store in messages.message_id. */
  messageId: string
  /** Zernio conversation id replies must be addressed to. */
  conversationId: string
  /** Zernio account id the message arrived on. */
  accountId: string | null
  /** Sender phone as Zernio reports it (digits, may carry a "+"). */
  phone: string
  name: string | null
  text: string | null
  contentType: 'text' | 'image' | 'document' | 'audio' | 'video'
  mediaUrl: string | null
  sentAt: string | null
}

export interface ZernioStatus {
  kind: 'status'
  eventId: string | null
  /** Zernio message id and the platform (wamid) id; either may match. */
  messageId: string | null
  platformMessageId: string | null
  status: 'delivered' | 'read' | 'failed'
  error: string | null
}

export type ZernioEvent = ZernioInbound | ZernioStatus

const ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'document'])

export function parseZernioEvent(payload: unknown): ZernioEvent | null {
  if (!isObj(payload)) return null
  const event = str(payload.event)
  const eventId = str(payload.id)
  const message = isObj(payload.message) ? payload.message : null
  if (!event || !message) return null

  if (event === 'message.received') {
    const conversation = isObj(payload.conversation) ? payload.conversation : null
    const account = isObj(payload.account) ? payload.account : null
    const sender = isObj(message.sender) ? message.sender : null
    const messageId = str(message.id) ?? str(message.platformMessageId)
    const conversationId = str(conversation?.id) ?? str(message.conversationId)
    const phone = str(sender?.phoneNumber)
    if (!messageId || !conversationId || !phone) return null

    const text = str(message.text)
    const attachment =
      Array.isArray(message.attachments) && isObj(message.attachments[0])
        ? message.attachments[0]
        : null
    const attType = str(attachment?.type)
    const contentType =
      !text && attType && ATTACHMENT_TYPES.has(attType)
        ? (attType as ZernioInbound['contentType'])
        : 'text'

    return {
      kind: 'message',
      eventId,
      messageId,
      conversationId,
      accountId: str(account?.accountId),
      phone,
      name: str(sender?.name),
      text,
      contentType,
      mediaUrl: contentType === 'text' ? null : str(attachment?.url),
      sentAt: str(message.sentAt),
    }
  }

  if (
    event === 'message.delivered' ||
    event === 'message.read' ||
    event === 'message.failed'
  ) {
    const error = isObj(payload.error) ? payload.error : null
    return {
      kind: 'status',
      eventId,
      messageId: str(message.id),
      platformMessageId: str(message.platformMessageId),
      status: event === 'message.delivered' ? 'delivered' : event === 'message.read' ? 'read' : 'failed',
      error: error ? (str(error.message) ?? str(error.title) ?? str(error.code)) : null,
    }
  }

  return null
}
