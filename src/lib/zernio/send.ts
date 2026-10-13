import type { SupabaseClient } from '@supabase/supabase-js'
import { sendZernioText } from './client'
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
}): Promise<{ whatsapp_message_id: string }> {
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

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: args.senderType ?? 'bot',
    content_type: 'text',
    content_text: text,
    message_id: messageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(`sent through Zernio but DB insert failed: ${msgErr.message}`)
  }

  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: text, last_message_at: now, updated_at: now })
    .eq('id', conversationId)

  return { whatsapp_message_id: messageId }
}
