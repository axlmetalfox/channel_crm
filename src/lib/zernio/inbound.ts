import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply, dispatchNonTextAutoReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import type { ZernioConfig } from './config'
import type { ZernioInbound, ZernioStatus } from './events'

// ============================================================
// Inbound processing for the Zernio channel.
//
// Mirrors what the Meta webhook does for a customer message — find or
// create the contact + conversation, store the message idempotently,
// bump the inbox, then hand it to flows, automations, the AI agent and
// the public webhooks — minus the Meta-only parts (media mirroring,
// reactions, interactive replies). It lives beside the Meta route
// instead of inside it so that route, which carries a lot of
// Meta-specific behaviour, is left untouched.
// ============================================================

type Row = Record<string, unknown> & { id: string }

async function findOrCreateContact(
  db: SupabaseClient,
  config: ZernioConfig,
  phone: string,
  name: string | null,
): Promise<{ contact: Row; wasCreated: boolean } | null> {
  const existing = await findExistingContact(db, config.accountId, phone)
  if (existing) {
    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { contact: existing as Row, wasCreated: false }
  }

  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: config.accountId,
      user_id: config.userId,
      phone,
      name: name || phone,
    })
    .select()
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, config.accountId, phone)
      if (raced) return { contact: raced as Row, wasCreated: false }
    }
    console.error('[zernio inbound] contact create failed:', error)
    return null
  }
  return { contact: data as Row, wasCreated: true }
}

/**
 * Contact for a sender whose phone number WhatsApp hides (a username
 * account). Matched through the conversation Zernio already knows them by;
 * created with an empty phone otherwise (the unique phone index ignores
 * empty values, and replies go by conversation id, not by number).
 */
async function findOrCreateHiddenNumberContact(
  db: SupabaseClient,
  config: ZernioConfig,
  msg: ZernioInbound,
): Promise<{ contact: Row; wasCreated: boolean } | null> {
  const { data: known } = await db
    .from('conversations')
    .select('contact_id')
    .eq('account_id', config.accountId)
    .eq('zernio_conversation_id', msg.conversationId)
    .limit(1)
    .maybeSingle()
  if (known?.contact_id) {
    const { data: contact } = await db
      .from('contacts')
      .select('*')
      .eq('id', known.contact_id as string)
      .maybeSingle()
    if (contact) return { contact: contact as Row, wasCreated: false }
  }

  const label = msg.name || (msg.username ? `@${msg.username.replace(/^@/, '')}` : null)
  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: config.accountId,
      user_id: config.userId,
      phone: '',
      name: label || 'WhatsApp',
    })
    .select()
    .single()
  if (error) {
    console.error('[zernio inbound] contact create failed:', error)
    return null
  }
  return { contact: data as Row, wasCreated: true }
}

async function findOrCreateConversation(
  db: SupabaseClient,
  config: ZernioConfig,
  contactId: string,
): Promise<{ conversation: Row; created: boolean } | null> {
  const find = () =>
    db
      .from('conversations')
      .select('*')
      .eq('account_id', config.accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)

  const { data: rows, error: findError } = await find()
  if (findError) {
    console.error('[zernio inbound] conversation lookup failed:', findError)
    return null
  }
  if (rows && rows.length > 0) return { conversation: rows[0] as Row, created: false }

  const { data, error } = await db
    .from('conversations')
    .insert({ account_id: config.accountId, user_id: config.userId, contact_id: contactId })
    .select()
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await find()
      if (raced && raced.length > 0) return { conversation: raced[0] as Row, created: false }
    }
    console.error('[zernio inbound] conversation create failed:', error)
    return null
  }
  return { conversation: data as Row, created: true }
}

/** Process one customer message that arrived through Zernio. */
export async function processZernioInbound(
  db: SupabaseClient,
  config: ZernioConfig,
  msg: ZernioInbound,
): Promise<void> {
  const phone = msg.phone ? normalizePhone(msg.phone) : ''

  // A customer who uses a WhatsApp username has no visible number: they are
  // recognised by Zernio's conversation id instead.
  const contactOutcome = phone
    ? await findOrCreateContact(db, config, phone, msg.name)
    : await findOrCreateHiddenNumberContact(db, config, msg)
  if (!contactOutcome) return
  const contact = contactOutcome.contact

  const convResult = await findOrCreateConversation(db, config, contact.id)
  if (!convResult) return
  const conversation = convResult.conversation

  // Replies are addressed to Zernio's conversation id: remember the
  // latest one.
  if (conversation.zernio_conversation_id !== msg.conversationId) {
    await db
      .from('conversations')
      .update({ zernio_conversation_id: msg.conversationId })
      .eq('id', conversation.id)
  }

  if (convResult.created) {
    await dispatchWebhookEvent(db, config.accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    })
  }

  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert: Zernio delivers at least once, so a replay hits
  // the unique (conversation_id, message_id) index and inserts nothing.
  const { data: inserted, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: msg.contentType,
        content_text: msg.text,
        media_url: msg.mediaUrl,
        message_id: msg.messageId,
        status: 'delivered',
        created_at: msg.sentAt ?? new Date().toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')
  if (msgError) {
    console.error('[zernio inbound] message insert failed:', msgError)
    return
  }
  if (!inserted || inserted.length === 0) return // replay

  const { error: bumpError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: msg.text || `[${msg.contentType}]`,
  })
  if (bumpError) console.error('[zernio inbound] conversation bump failed:', bumpError)

  await reopenClosedConversation(db, conversation as { id: string; status?: string | null })

  const inboundText = msg.text ?? ''

  const flowResult = await dispatchInboundToFlows({
    accountId: config.accountId,
    userId: config.userId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: { kind: 'text', text: inboundText, meta_message_id: msg.messageId },
    isFirstInboundMessage,
  })

  const triggers: ('new_contact_created' | 'first_inbound_message' | 'new_message_received' | 'keyword_match')[] = []
  if (!flowResult.consumed) triggers.push('new_message_received', 'keyword_match')
  if (contactOutcome.wasCreated) triggers.unshift('new_contact_created')
  if (isFirstInboundMessage) triggers.unshift('first_inbound_message')
  for (const triggerType of triggers) {
    await runAutomationsForTrigger({
      accountId: config.accountId,
      triggerType,
      contactId: contact.id,
      context: { message_text: inboundText, conversation_id: conversation.id },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowResult.consumed) {
    const aiArgs = {
      accountId: config.accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId: config.userId,
      inboundMessageId: (inserted[0] as { id: string }).id,
    }
    // Text goes to the agent; anything else (voice note, photo…) gets a
    // fixed "please write it" reply instead of silence.
    if (inboundText.trim()) await dispatchInboundToAiReply(aiArgs)
    else await dispatchNonTextAutoReply(aiArgs)
  }

  await dispatchWebhookEvent(db, config.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: msg.messageId,
    content_type: msg.contentType,
    text: msg.text,
  })
}

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 }

/**
 * Apply a delivery status to a message we sent. Never moves a message
 * backwards (a late "delivered" after "read") and only lets `failed`
 * override the early states.
 */
export async function processZernioStatus(
  db: SupabaseClient,
  config: ZernioConfig,
  event: ZernioStatus,
): Promise<void> {
  const ids = [event.messageId, event.platformMessageId].filter((v): v is string => !!v)
  if (ids.length === 0) return

  // Scope to this account's conversations so a status event can never
  // touch another tenant's message.
  const { data: rows } = await db
    .from('messages')
    .select('id, status, conversation:conversations!inner(account_id)')
    .in('message_id', ids)
    .eq('conversations.account_id', config.accountId)
    .limit(1)
  const row = rows?.[0] as { id: string; status: string } | undefined
  if (!row) return

  const current = STATUS_RANK[row.status] ?? 0
  if (event.status === 'failed') {
    if (current >= STATUS_RANK.delivered) return
  } else if ((STATUS_RANK[event.status] ?? 0) <= current) {
    return
  }

  await db.from('messages').update({ status: event.status }).eq('id', row.id)
}
