import type { Message } from '@/types'

/**
 * Photos and videos from a customer are blurred until a person clicks them,
 * so nobody is surprised by something offensive:
 *   - always when the vision model flagged the file as explicit or offensive;
 *   - otherwise while nobody on the team has answered the conversation yet
 *     (a new customer). Once a colleague has replied, the chat is a known one
 *     and its media shows normally.
 * A click reveals that one file (kept in `revealed` for the open thread).
 */
export function isMediaBlurred(
  message: Pick<Message, 'id' | 'sender_type' | 'content_type' | 'ai_flag'>,
  ctx: { humanReplied: boolean; revealed: ReadonlySet<string> },
): boolean {
  if (message.sender_type !== 'customer') return false
  if (message.content_type !== 'image' && message.content_type !== 'video') return false
  if (ctx.revealed.has(message.id)) return false
  return message.ai_flag === 'offensive' || !ctx.humanReplied
}

/** Whether a person on the team (not the AI agent) has written in the thread. */
export function hasHumanReply(messages: Pick<Message, 'sender_type'>[]): boolean {
  return messages.some((m) => m.sender_type === 'agent')
}
