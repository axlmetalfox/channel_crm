import type { SupabaseClient } from '@supabase/supabase-js'
import { localDayKey } from './date-utils'

// ============================================================
// Incoming conversations vs. conversions for a chosen date range.
//
//   incoming   conversations that started in the range
//   converted  conversations with a registered lead (a lead_intakes row
//              created in the range, whose interview was finished and
//              authorised: pending / delivered / failed / no_endpoint;
//              not incomplete, no_consent or a draft nobody sent)
//   by AI      lead captured by the agent (source 'ai')
//   by human   lead an agent sent by hand (source 'manual')
//
//   AI effectiveness   of the conversations the AI interviewed (it wrote at
//                      least once in the range), how many it registered
//   per person         leads each agent registered and the average time
//                      from the agent's first message in the chat to the
//                      lead reaching the CRM (when the chat has no message
//                      from a person yet, from the moment the agent opened
//                      the form)
// ============================================================

/** Lead statuses that count as "registered". */
export const REGISTERED_STATUSES = ['pending', 'delivered', 'failed', 'no_endpoint']

const PAGE = 1000
const MAX_PAGES = 30

export interface ConversionDay {
  day: string // YYYY-MM-DD local
  incoming: number
  byAi: number
  byHuman: number
}

export interface AgentConversion {
  userId: string
  name: string
  registered: number
  /** Average minutes to register, null when no lead has a usable timing. */
  avgMinutes: number | null
}

export interface ConversionSummary {
  ai: { interviewed: number; registered: number; rate: number }
  agents: AgentConversion[]
  incoming: number
  converted: number
  byAi: number
  byHuman: number
  /** converted / incoming, 0 when nothing came in. */
  rate: number
  days: ConversionDay[]
}

interface ConvRow {
  created_at: string
}
interface LeadRow {
  conversation_id: string | null
  source: string
  created_at: string
  created_by_user_id?: string | null
  delivered_at?: string | null
}

/** Extra facts looked up from messages and profiles. */
export interface ConversionExtras {
  /** Conversations where the AI wrote at least once in the range. */
  aiConversationIds: string[]
  /** conversation id -> time of the first message a person wrote in it. */
  firstHumanMessageAt: Record<string, string>
  /** user id -> display name. */
  names: Record<string, string>
}

/** Every local day key from `from` to `to`, both inclusive (YYYY-MM-DD). */
export function dayKeysBetween(from: string, to: string): string[] {
  const keys: string[] = []
  const d = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  for (let i = 0; d <= end && i < 400; i++) {
    keys.push(localDayKey(d))
    d.setDate(d.getDate() + 1)
  }
  return keys
}

/**
 * Pure aggregation. A conversation counts once per source, and once in the
 * total even if both the agent and a person registered it.
 */
export function summarizeConversion(
  from: string,
  to: string,
  conversations: ConvRow[],
  leads: LeadRow[],
  extras: ConversionExtras = { aiConversationIds: [], firstHumanMessageAt: {}, names: {} },
): ConversionSummary {
  const days = new Map<string, ConversionDay>()
  for (const day of dayKeysBetween(from, to)) {
    days.set(day, { day, incoming: 0, byAi: 0, byHuman: 0 })
  }
  for (const c of conversations) {
    const bucket = days.get(localDayKey(c.created_at))
    if (bucket) bucket.incoming += 1
  }

  const ai = new Set<string>()
  const human = new Set<string>()
  const all = new Set<string>()
  const aiByDay = new Map<string, Set<string>>()
  const humanByDay = new Map<string, Set<string>>()
  leads.forEach((lead, i) => {
    // A lead whose chat was deleted still counts: give it its own key.
    const key = lead.conversation_id ?? `lead-${i}`
    const day = localDayKey(lead.created_at)
    const manual = lead.source === 'manual'
    ;(manual ? human : ai).add(key)
    all.add(key)
    const perDay = manual ? humanByDay : aiByDay
    if (!perDay.has(day)) perDay.set(day, new Set())
    perDay.get(day)!.add(key)
  })
  for (const [day, bucket] of days) {
    bucket.byAi = aiByDay.get(day)?.size ?? 0
    bucket.byHuman = humanByDay.get(day)?.size ?? 0
  }

  // The AI's interviews: every chat it wrote in, plus any it registered.
  const interviewed = new Set<string>([...extras.aiConversationIds, ...ai])

  // One entry per (person, chat): the first time that person's lead was sent.
  const perAgent = new Map<string, { chats: Set<string>; minutes: number[] }>()
  leads.forEach((lead, i) => {
    if (lead.source !== 'manual' || !lead.created_by_user_id) return
    const entry = perAgent.get(lead.created_by_user_id) ?? { chats: new Set(), minutes: [] }
    perAgent.set(lead.created_by_user_id, entry)
    const key = lead.conversation_id ?? `lead-${i}`
    if (entry.chats.has(key)) return
    entry.chats.add(key)
    const sent = new Date(lead.delivered_at ?? lead.created_at).getTime()
    const spoke = lead.conversation_id ? extras.firstHumanMessageAt[lead.conversation_id] : undefined
    const spokeAt = spoke ? new Date(spoke).getTime() : NaN
    const opened = new Date(lead.created_at).getTime()
    // A person's message after the lead was opened says nothing about effort.
    const start = Number.isFinite(spokeAt) && spokeAt <= opened ? spokeAt : opened
    const minutes = (sent - start) / 60000
    if (Number.isFinite(minutes) && minutes >= 0) entry.minutes.push(minutes)
  })
  const agents: AgentConversion[] = [...perAgent.entries()]
    .map(([userId, e]) => ({
      userId,
      name: extras.names[userId] ?? '',
      registered: e.chats.size,
      avgMinutes: e.minutes.length ? e.minutes.reduce((a, b) => a + b, 0) / e.minutes.length : null,
    }))
    .sort((a, b) => b.registered - a.registered)

  const incoming = conversations.length
  return {
    ai: {
      interviewed: interviewed.size,
      registered: ai.size,
      rate: interviewed.size > 0 ? ai.size / interviewed.size : 0,
    },
    agents,
    incoming,
    converted: all.size,
    byAi: ai.size,
    byHuman: human.size,
    rate: incoming > 0 ? all.size / incoming : 0,
    days: [...days.values()],
  }
}

/** Page through a query that can return more rows than PostgREST's cap. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1)
    if (error) throw error
    const got = data ?? []
    rows.push(...got)
    if (got.length < PAGE) break
  }
  return rows
}

/**
 * Load the summary for `from`..`to` (inclusive local days, YYYY-MM-DD).
 * RLS scopes both tables to the signed-in user's account.
 */
export async function loadConversionSummary(
  db: SupabaseClient,
  from: string,
  to: string,
): Promise<ConversionSummary> {
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  end.setDate(end.getDate() + 1)

  const [conversations, leads] = await Promise.all([
    fetchAll<ConvRow>((a, b) =>
      db
        .from('conversations')
        .select('created_at')
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString())
        .order('created_at', { ascending: true })
        .range(a, b),
    ),
    fetchAll<LeadRow>((a, b) =>
      db
        .from('lead_intakes')
        .select('conversation_id, source, created_at, created_by_user_id, delivered_at')
        .in('status', REGISTERED_STATUSES)
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString())
        .order('created_at', { ascending: true })
        .range(a, b),
    ),
  ])

  const [aiConversationIds, firstHumanMessageAt, names] = await Promise.all([
    loadAiConversationIds(db, start, end),
    loadFirstHumanMessages(db, leads),
    loadNames(db, leads),
  ])

  return summarizeConversion(from, to, conversations, leads, {
    aiConversationIds,
    firstHumanMessageAt,
    names,
  })
}

/** Chats where the AI agent wrote at least once between `start` and `end`. */
async function loadAiConversationIds(db: SupabaseClient, start: Date, end: Date): Promise<string[]> {
  const rows = await fetchAll<{ conversation_id: string }>((a, b) =>
    db
      .from('messages')
      .select('conversation_id')
      .eq('sender_type', 'bot')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: true })
      .range(a, b),
  )
  return [...new Set(rows.map((r) => r.conversation_id))]
}

const CHUNK = 40

/** First message a person wrote in each chat that has a manual lead. */
async function loadFirstHumanMessages(
  db: SupabaseClient,
  leads: LeadRow[],
): Promise<Record<string, string>> {
  const ids = [
    ...new Set(
      leads.filter((l) => l.source === 'manual' && l.conversation_id).map((l) => l.conversation_id as string),
    ),
  ]
  const first: Record<string, string> = {}
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const rows = await fetchAll<{ conversation_id: string; created_at: string }>((a, b) =>
      db
        .from('messages')
        .select('conversation_id, created_at')
        .eq('sender_type', 'agent')
        .in('conversation_id', chunk)
        .order('created_at', { ascending: true })
        .range(a, b),
    )
    for (const r of rows) if (!first[r.conversation_id]) first[r.conversation_id] = r.created_at
  }
  return first
}

/** Display names of the people who registered manual leads. */
async function loadNames(db: SupabaseClient, leads: LeadRow[]): Promise<Record<string, string>> {
  const ids = [
    ...new Set(leads.map((l) => l.created_by_user_id).filter((id): id is string => !!id)),
  ]
  if (ids.length === 0) return {}
  const { data } = await db.from('profiles').select('user_id, full_name').in('user_id', ids)
  const names: Record<string, string> = {}
  for (const p of (data ?? []) as { user_id: string; full_name: string | null }[]) {
    if (p.full_name) names[p.user_id] = p.full_name
  }
  return names
}
