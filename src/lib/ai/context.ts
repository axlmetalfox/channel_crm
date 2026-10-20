import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  ai_description?: string | null
}

/** Marks text that came from a voice note, so the agent knows it may contain
 *  recognition mistakes (emails, IDs, phone numbers, proper names). */
export const AUDIO_TRANSCRIPT_PREFIX = '[Audio transcrito] '

/** What the agent reads for a photo or video the customer sent: the
 *  automatic description (which may be wrong) and the caption, if any. When
 *  no description could be made, only the fact that it arrived. */
export function describeMediaForAgent(m: DbMessage): string {
  const noun = m.content_type === 'video' ? 'un video' : 'una imagen'
  const caption = m.content_text?.trim()
  const description = m.ai_description?.trim()
  const parts = [`[El cliente envió ${noun}.`]
  if (description) {
    parts.push(` Descripción automática, puede tener errores: ${description}`)
  } else {
    parts.push(' No se pudo analizar el contenido.')
  }
  if (caption) parts.push(` Texto que la acompaña: ${caption}`)
  return parts.join('') + ']'
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, ai_description')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio', 'image', 'video'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const isCustomerMedia = (m: DbMessage) =>
    m.sender_type === 'customer' && (m.content_type === 'image' || m.content_type === 'video')
  return rows
    .filter((m) => isCustomerMedia(m) || (m.content_text && m.content_text.trim()))
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: isCustomerMedia(m)
        ? describeMediaForAgent(m)
        : (m.content_type === 'audio' ? AUDIO_TRANSCRIPT_PREFIX : '') + m.content_text!.trim(),
    }))
}
