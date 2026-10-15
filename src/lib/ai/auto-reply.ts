import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { aiReplyCapResetHours, buildSystemPrompt } from './defaults'
import { fallbackText } from './fallback'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { parseLeadCompletion } from '@/lib/leads/sentinel'
import { captureLead } from '@/lib/leads/capture'
import { lookupConfigured, resolveCustomerContext, type CrmMatch } from '@/lib/leads/lookup'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    if (await hasActiveAutoResponder(db, accountId)) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, crm_match')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound). At the cap the
    // conversation either gets its budget back (the customer returned
    // after a quiet spell) or is told, once, that the limit was reached —
    // never silence.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      const resumed = await resolveReplyCap({
        db,
        config,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
      })
      if (!resumed) return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Is this person already in the CRM? Then they are not interviewed again.
    const customerContext =
      config.leadCaptureEnabled && lookupConfigured()
        ? await resolveCustomerContext({
            db,
            conversationId,
            contactId,
            stored: (conv.crm_match as CrmMatch | null) ?? null,
            messages,
          })
        : null

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      handoffEnabled: config.handoffEnabled,
      leadCapture: config.leadCaptureEnabled,
      customerContext,
    })

    const generated = await generateReply({
      config,
      systemPrompt,
      messages,
    })
    const { handoff, usage } = generated
    // The completion marker is for us, never for the customer: strip it
    // from every reply, and only act on it when lead capture is on.
    const { text, complete } = parseLeadCompletion(generated.text)
    const interviewDone = complete && config.leadCaptureEnabled

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (config.handoffEnabled && (handoff || !text)) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Handoff is off for this account: never pause the thread or route it
    // to a person. If the model still produced nothing to say (it emitted
    // only the control phrase, or came back empty), there is nothing to
    // send — leave the conversation untouched and let the next inbound
    // message try again.
    if (!text) {
      console.warn(
        `[ai auto-reply] handoff is disabled for account ${accountId} and the model returned no reply text; nothing sent.`,
      )
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    const sent = await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })

    // The closing message reached the customer: hand the interview to the
    // lead pipeline. It records its own outcome and never throws.
    if (interviewDone) {
      await captureLead({
        db,
        config,
        accountId,
        conversationId,
        contactId,
        triggerMessageId: sent.whatsapp_message_id,
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/** True when the account has a message-level automation that already
 *  answers every inbound (the AI stands down so the customer is not
 *  texted twice). */
async function hasActiveAutoResponder(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<boolean> {
  const { data } = await db
    .from('automations')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .in('trigger_type', ['new_message_received', 'keyword_match'])
    .limit(1)
  return !!data && data.length > 0
}

/** The last message the bot sent in a conversation, if any. */
async function lastBotMessage(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<{ created_at: string; content_text: string | null } | null> {
  const { data } = await db
    .from('messages')
    .select('created_at, content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'bot')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { created_at: string; content_text: string | null } | null) ?? null
}

/**
 * The conversation is at its auto-reply cap. If the bot has been quiet
 * for a while the customer is coming back to a fresh exchange: give the
 * budget back and let the reply proceed (returns true). Otherwise tell
 * the customer once that the limit was reached (returns false), instead
 * of leaving them unanswered.
 */
async function resolveReplyCap(args: {
  db: ReturnType<typeof supabaseAdmin>
  config: NonNullable<Awaited<ReturnType<typeof loadAiConfig>>>
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
}): Promise<boolean> {
  const { db, config, accountId, conversationId, contactId, configOwnerUserId } = args
  const last = await lastBotMessage(db, conversationId)
  const quietMs = last ? Date.now() - new Date(last.created_at).getTime() : Infinity

  if (quietMs >= aiReplyCapResetHours() * 3_600_000) {
    await db.from('conversations').update({ ai_reply_count: 0 }).eq('id', conversationId)
    return true
  }

  const text = fallbackText('replyLimit', config.replyLimitReply)
  if (last?.content_text?.trim() === text) return false // already told them
  await engineSendText({
    accountId,
    userId: configOwnerUserId,
    conversationId,
    contactId,
    text,
    aiGenerated: true,
  })
  return false
}

/**
 * The customer sent something that is not text (a voice note, a photo, a
 * document…). The agent only reads text, so reply with a fixed message
 * asking for text instead of staying silent. Same eligibility gates as
 * the text path; costs no AI call and does not use the reply budget. A
 * second non-text message in a row is not answered again.
 */
export async function dispatchNonTextAutoReply(args: DispatchArgs): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args
  try {
    const db = supabaseAdmin()
    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return
    if (await hasActiveAutoResponder(db, accountId)) return

    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv || conv.assigned_agent_id || conv.ai_autoreply_disabled) return

    const text = fallbackText('nonText', config.nonTextReply)
    const last = await lastBotMessage(db, conversationId)
    if (last?.content_text?.trim() === text) return

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] non-text reply failed:', err)
  }
}
