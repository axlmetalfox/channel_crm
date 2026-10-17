// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

import type { AutoReplySchedule } from './schedule'

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** When false the bot never hands a conversation to a human and is not
   *  told it can: it keeps replying within the business instructions.
   *  Meant for capture-only agents with no human in the loop. */
  handoffEnabled: boolean
  /** When true the bot ends an interview with a completion marker and
   *  wacrm then extracts the lead and sends it to the account's CRM via
   *  the `lead.captured` webhook. Needs the OpenAI-compatible provider. */
  leadCaptureEnabled: boolean
  /** Weekly windows when the agent answers; null = always. */
  autoReplySchedule: AutoReplySchedule | null
  /** Data-processing notice sent as the first message of a conversation;
   *  continuing the chat is the acceptance. Null = none. */
  consentNotice: string | null
  /** Fixed reply to a non-text message; null = built-in default. */
  nonTextReply: string | null
  /** Fixed reply sent once at the reply cap; null = built-in default. */
  replyLimitReply: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** What the gateway charged for this call, in the gateway's own credits
   *  (the Hostinger AI router reports `usage.credits_charged`). Absent on
   *  providers that do not report it. This is OUR cost, kept for margin
   *  analysis; it is never shown to customers. */
  routerCredits?: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
