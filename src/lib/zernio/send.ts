import type { SupabaseClient } from '@supabase/supabase-js'
import { sendZernioAttachment, sendZernioTemplate, sendZernioText, startZernioConversation } from './client'
import type { ZernioConfig } from './config'

/**
 * Send a text message through Zernio and persist it exactly like the
 * Meta send paths do (a `messages` row + the conversation's
 * last-message summary), so the inbox renders it the same way.
 *
 * Replies are addressed to the Zernio conversation id captured from the
 * customer's first inbound message; a thread that has never received a
 * message through Zernio has none and cannot be written to (Zernio only
 * lets us message a customer inside the 24h window anyway).
 */
export async function sendTextViaZernio(args: {
  db: SupabaseClient
  config: ZernioConfig
  conversationId: string
  text: string
  /** messages.sender_type: 'bot' for automations/AI, 'agent' for people. */
  senderType?: 'bot' | 'agent'
  aiGenerated?: boolean
  /** Dedupe key so a retried send is not delivered twice. */
  idempotencyKey?: string
}): Promise<{ whatsapp_message_id: string; message_id: string }> {
  const { db, config, conversationId, text } = args

  const { data: conv, error } = await db
    .from('conversations')
    .select('zernio_conversation_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (error) throw error
  const zernioConversationId = conv?.zernio_conversation_id as string | null | undefined
  if (!zernioConversationId) {
    throw new Error(
      'This conversation has no Zernio thread yet — the customer has to write first.',
    )
  }

  const { messageId } = await sendZernioText({
    apiKey: config.apiKey,
    accountId: config.zernioAccountId,
    conversationId: zernioConversationId,
    text,
    idempotencyKey: args.idempotencyKey,
  })

  const { data: row, error: msgErr } = await db
    .from('messages')
    .insert({
    conversation_id: conversationId,
    sender_type: args.senderType ?? 'bot',
    content_type: 'text',
    content_text: text,
    message_id: messageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
    })
    .select('id')
    .single()
  if (msgErr || !row) {
    throw new Error(`sent through Zernio but DB insert failed: ${msgErr?.message ?? 'no row'}`)
  }

  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: text, last_message_at: now, updated_at: now })
    .eq('id', conversationId)

  return { whatsapp_message_id: messageId, message_id: (row as { id: string }).id }
}

export type ZernioMediaKind = 'image' | 'video' | 'audio' | 'document'

/**
 * Send a file through Zernio and persist it like the text path does. The
 * file is already in our public `chat-media` bucket (the composer uploads
 * it first); Zernio fetches it from there.
 */
export async function sendMediaViaZernio(args: {
  db: SupabaseClient
  config: ZernioConfig
  conversationId: string
  kind: ZernioMediaKind
  mediaUrl: string
  caption?: string | null
  filename?: string | null
  senderType?: 'bot' | 'agent'
  idempotencyKey?: string
}): Promise<{ whatsapp_message_id: string; message_id: string }> {
  const { db, config, conversationId, kind, mediaUrl } = args

  const { data: conv, error } = await db
    .from('conversations')
    .select('zernio_conversation_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (error) throw error
  const zernioConversationId = conv?.zernio_conversation_id as string | null | undefined
  if (!zernioConversationId) {
    throw new Error('This conversation has no Zernio thread yet — the customer has to write first.')
  }

  // A recorded voice note is OGG/Opus; anything else is a plain audio file.
  const voiceNote = kind === 'audio' && /\.(ogg|opus)(\?|$)/i.test(mediaUrl)
  const { messageId } = await sendZernioAttachment({
    apiKey: config.apiKey,
    accountId: config.zernioAccountId,
    conversationId: zernioConversationId,
    attachmentUrl: mediaUrl,
    attachmentType: kind === 'document' ? 'file' : kind,
    text: kind === 'audio' ? null : args.caption,
    attachmentName: kind === 'document' ? args.filename : null,
    voiceNote,
    idempotencyKey: args.idempotencyKey,
  })

  const shownText = kind === 'document' ? args.caption || args.filename || null : kind === 'audio' ? null : args.caption || null
  const { data: row, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: args.senderType ?? 'agent',
      content_type: kind,
      content_text: shownText,
      media_url: mediaUrl,
      message_id: messageId,
      status: 'sent',
    })
    .select('id')
    .single()
  if (msgErr || !row) {
    throw new Error(`sent through Zernio but DB insert failed: ${msgErr?.message ?? 'no row'}`)
  }

  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: shownText || `[${kind}]`, last_message_at: now, updated_at: now })
    .eq('id', conversationId)

  return { whatsapp_message_id: messageId, message_id: (row as { id: string }).id }
}

/**
 * Send an approved WhatsApp template and persist it like the other paths.
 *
 * A template is the only message WhatsApp allows outside the 24h window, and
 * the only way to reach a customer who has no Zernio thread yet (a chat
 * imported from another system, or a customer who never wrote to this
 * number): then the conversation is OPENED by phone number and the new
 * Zernio conversation id is saved on the TUYO conversation, so everything
 * after (the customer's reply, free text inside the window) works as usual.
 */
export async function sendTemplateViaZernio(args: {
  db: SupabaseClient
  config: ZernioConfig
  conversationId: string
  templateName: string
  language: string
  /** Values for {{1}}, {{2}}… in order. */
  bodyParams: string[]
  /** The template body with the values filled in, as shown in the inbox. */
  renderedText: string
  idempotencyKey?: string
}): Promise<{ whatsapp_message_id: string; message_id: string }> {
  const { db, config, conversationId, templateName, language, bodyParams, renderedText } = args

  const { data: conv, error } = await db
    .from('conversations')
    .select('zernio_conversation_id, contact:contacts(phone)')
    .eq('id', conversationId)
    .maybeSingle()
  if (error) throw error
  const zernioConversationId = conv?.zernio_conversation_id as string | null | undefined
  const contact = conv?.contact as { phone?: string | null } | { phone?: string | null }[] | null | undefined
  const phone = (Array.isArray(contact) ? contact[0]?.phone : contact?.phone) ?? ''

  let messageId: string
  if (zernioConversationId) {
    ;({ messageId } = await sendZernioTemplate({
      apiKey: config.apiKey,
      accountId: config.zernioAccountId,
      conversationId: zernioConversationId,
      name: templateName,
      language,
      bodyParams,
      idempotencyKey: args.idempotencyKey,
    }))
  } else {
    if (!phone.replace(/\D/g, '')) {
      throw new Error('This customer has no visible phone number, so a new chat cannot be started with a template.')
    }
    const started = await startZernioConversation({
      apiKey: config.apiKey,
      accountId: config.zernioAccountId,
      phone,
      name: templateName,
      language,
      bodyParams,
      idempotencyKey: args.idempotencyKey,
    })
    messageId = started.messageId
    await db
      .from('conversations')
      .update({ zernio_conversation_id: started.conversationId })
      .eq('id', conversationId)
  }

  const { data: row, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: 'template',
      content_text: renderedText,
      template_name: templateName,
      message_id: messageId,
      status: 'sent',
    })
    .select('id')
    .single()
  if (msgErr || !row) {
    throw new Error(`sent through Zernio but DB insert failed: ${msgErr?.message ?? 'no row'}`)
  }

  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: renderedText, last_message_at: now, updated_at: now })
    .eq('id', conversationId)

  return { whatsapp_message_id: messageId, message_id: (row as { id: string }).id }
}
