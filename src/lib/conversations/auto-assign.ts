import type { SupabaseClient } from '@supabase/supabase-js'
import { isOnDuty, offDutySince, parseSchedule } from '@/lib/ai/schedule'

// ============================================================
// Hand stalled conversations to a person, round robin.
//
// Each account can switch on a rule: a conversation with no activity for
// N minutes is assigned to one of its agents, taking them in turns. It is
// the bridge between the AI agent (which opens and interviews) and the
// human team (which follows up what the AI could not finish).
//
// Guards that keep it sensible:
//   - nothing is assigned while the AI agent is on duty (per the
//     account's schedule): that is when nobody is at the desks;
//   - the inactivity clock starts when the working hours start, so the team
//     gets the wait too instead of receiving the whole night's backlog at
//     the opening bell;
//   - conversations are handed out gradually (a few per agent per sweep),
//     most recent first, and not at all once they are older than a limit;
//   - agents marked unavailable are skipped;
//   - only conversations still open or pending and with no owner qualify
//     (a delivered lead closes its conversation).
// Assigning a conversation silences the AI agent on it: a person owns it.
//
// Besides the recurring rule, an admin can schedule ONE moment
// (accounts.auto_assign_once_at) at which everything that meets the rule is
// handed out at once, equally, instead of gradually (runScheduledAssign).
// ============================================================


/**
 * The agents to give `count` conversations to, in turn, continuing after
 * `cursor` (the agent who got the previous one). Pure.
 */
export function roundRobin(agentIds: string[], cursor: string | null, count: number): string[] {
  if (agentIds.length === 0 || count <= 0) return []
  const at = cursor ? agentIds.indexOf(cursor) : -1
  const start = (at + 1) % agentIds.length
  return Array.from({ length: count }, (_, i) => agentIds[(start + i) % agentIds.length])
}

interface AccountRule {
  id: string
  auto_assign_after_minutes: number
  auto_assign_cursor: string | null
  auto_assign_max_age_days: number
  auto_assign_batch_per_agent: number
}

/** The agents who take part in the rotation, in a stable order. */
async function availableAgents(db: SupabaseClient, accountId: string): Promise<string[]> {
  const { data } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('account_role', 'agent')
    .eq('available_for_assignment', true)
    .order('created_at', { ascending: true })
  return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id)
}

/**
 * Give each conversation to the next agent in turn. A conversation someone
 * took meanwhile is left alone. Remembers where the rotation stopped.
 */
async function handOut(
  db: SupabaseClient,
  accountId: string,
  ids: string[],
  agents: string[],
  cursor: string | null,
  now: Date,
): Promise<{ done: number; perAgent: Record<string, number> }> {
  const turns = roundRobin(agents, cursor, ids.length)
  const perAgent: Record<string, number> = {}
  let done = 0
  let lastAgent: string | null = null
  for (let i = 0; i < ids.length; i++) {
    // Guarded on "still unassigned": a person who took it meanwhile wins.
    const { data: updated } = await db
      .from('conversations')
      .update({ assigned_agent_id: turns[done], updated_at: now.toISOString() })
      .eq('id', ids[i])
      .is('assigned_agent_id', null)
      .select('id')
    if (Array.isArray(updated) && updated.length > 0) {
      lastAgent = turns[done]
      perAgent[turns[done]] = (perAgent[turns[done]] ?? 0) + 1
      done += 1
    }
  }
  if (lastAgent) {
    await db.from('accounts').update({ auto_assign_cursor: lastAgent }).eq('id', accountId)
  }
  return { done, perAgent }
}

/**
 * Apply every account's rule. Never throws; returns how many
 * conversations were assigned in total.
 */
export async function runAutoAssign(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ assigned: number }> {
  let assigned = 0
  try {
    const { data: accounts } = await db
      .from('accounts')
      .select(
        'id, auto_assign_after_minutes, auto_assign_cursor, auto_assign_max_age_days, auto_assign_batch_per_agent',
      )
      .eq('auto_assign_enabled', true)

    for (const account of (accounts ?? []) as AccountRule[]) {
      try {
        assigned += await assignForAccount(db, account, now)
      } catch (err) {
        console.error(`[auto-assign] account ${account.id} failed:`, err)
      }
    }
  } catch (err) {
    console.error('[auto-assign] sweep failed:', err)
  }
  return { assigned }
}

async function assignForAccount(
  db: SupabaseClient,
  account: AccountRule,
  now: Date,
): Promise<number> {
  // While the AI agent covers the account, nobody is at the desks.
  const { data: ai } = await db
    .from('ai_configs')
    .select('auto_reply_schedule')
    .eq('account_id', account.id)
    .maybeSingle()
  const schedule = parseSchedule(ai?.auto_reply_schedule)
  const hours = schedule && typeof schedule !== 'string' ? schedule : null
  if (hours && isOnDuty(hours, now)) return 0

  // The wait counts from the moment the team started working, not from the
  // middle of the night: right at the opening nothing is due yet.
  const opened = offDutySince(hours, now)
  if (opened && now.getTime() - opened.getTime() < account.auto_assign_after_minutes * 60_000) return 0

  const agents = await availableAgents(db, account.id)
  if (agents.length === 0) return 0

  const cutoff = new Date(now.getTime() - account.auto_assign_after_minutes * 60_000).toISOString()
  const oldest = new Date(now.getTime() - account.auto_assign_max_age_days * 86_400_000).toISOString()
  const { data: stalled } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', account.id)
    .in('status', ['open', 'pending'])
    .is('assigned_agent_id', null)
    .not('last_message_at', 'is', null)
    .lt('last_message_at', cutoff)
    .gte('last_message_at', oldest)
    // Gradual: a few per agent per sweep. Open conversations (the customer is
    // waiting for us; "open" sorts before "pending") go first, then the pending
    // ones (the ball is in the customer's court); within each, the freshest
    // leads before the ones that have been cold for days.
    .order('status', { ascending: true })
    .order('last_message_at', { ascending: false })
    .limit(agents.length * account.auto_assign_batch_per_agent)
  const ids = ((stalled ?? []) as { id: string }[]).map((r) => r.id)
  if (ids.length === 0) return 0

  const { done } = await handOut(db, account.id, ids, agents, account.auto_assign_cursor, now)
  return done
}

// ------------------------------------------------------------
// The one-time scheduled hand-out.
// ------------------------------------------------------------

const PAGE = 1000
const MAX_PAGES = 10

/** Open or pending conversations nobody owns that meet the inactivity rule. */
function stalledFilter(account: AccountRule, now: Date) {
  return {
    cutoff: new Date(now.getTime() - account.auto_assign_after_minutes * 60_000).toISOString(),
    oldest: new Date(now.getTime() - account.auto_assign_max_age_days * 86_400_000).toISOString(),
  }
}

/** How many conversations meet the rule right now (for the admin's preview). */
export async function countEligible(
  db: SupabaseClient,
  account: AccountRule,
  now: Date = new Date(),
): Promise<number> {
  const { cutoff, oldest } = stalledFilter(account, now)
  const { count } = await db
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', account.id)
    .in('status', ['open', 'pending'])
    .is('assigned_agent_id', null)
    .not('last_message_at', 'is', null)
    .lt('last_message_at', cutoff)
    .gte('last_message_at', oldest)
  return count ?? 0
}

export interface ScheduledAssignResult {
  ran_at: string
  assigned: number
  per_agent: Record<string, number>
  /** Why nothing was assigned, when that is the case. */
  reason?: 'no_agents' | 'nothing_to_assign' | 'error'
}

/** Hand out everything that meets the rule, equally, in one go. */
async function assignEverything(
  db: SupabaseClient,
  account: AccountRule,
  now: Date,
): Promise<ScheduledAssignResult> {
  const base = { ran_at: now.toISOString(), assigned: 0, per_agent: {} as Record<string, number> }
  const agents = await availableAgents(db, account.id)
  if (agents.length === 0) return { ...base, reason: 'no_agents' }

  const { cutoff, oldest } = stalledFilter(account, now)
  const ids: string[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', account.id)
      .in('status', ['open', 'pending'])
      .is('assigned_agent_id', null)
      .not('last_message_at', 'is', null)
      .lt('last_message_at', cutoff)
      .gte('last_message_at', oldest)
      // Open before pending, then freshest first, so everyone gets a mix of
      // recent and older chats.
      .order('status', { ascending: true })
      .order('last_message_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    const rows = (data ?? []) as { id: string }[]
    ids.push(...rows.map((r) => r.id))
    if (rows.length < PAGE) break
  }
  if (ids.length === 0) return { ...base, reason: 'nothing_to_assign' }

  const { done, perAgent } = await handOut(db, account.id, ids, agents, account.auto_assign_cursor, now)
  return { ...base, assigned: done, per_agent: perAgent, ...(done === 0 ? { reason: 'nothing_to_assign' as const } : {}) }
}

/**
 * Run the scheduled hand-out of every account whose time has come. The
 * schedule is cleared first (claimed), so overlapping sweeps cannot run it
 * twice. Never throws; returns how many conversations were assigned.
 */
export async function runScheduledAssign(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ assigned: number }> {
  let assigned = 0
  try {
    const { data: due } = await db
      .from('accounts')
      .select(
        'id, auto_assign_after_minutes, auto_assign_cursor, auto_assign_max_age_days, auto_assign_batch_per_agent, auto_assign_once_at',
      )
      .not('auto_assign_once_at', 'is', null)
      .lte('auto_assign_once_at', now.toISOString())

    for (const account of (due ?? []) as (AccountRule & { auto_assign_once_at: string })[]) {
      const { data: claimed } = await db
        .from('accounts')
        .update({ auto_assign_once_at: null })
        .eq('id', account.id)
        .eq('auto_assign_once_at', account.auto_assign_once_at)
        .select('id')
      if (!Array.isArray(claimed) || claimed.length === 0) continue

      let result: ScheduledAssignResult
      try {
        result = await assignEverything(db, account, now)
        assigned += result.assigned
      } catch (err) {
        console.error(`[scheduled assign] account ${account.id} failed:`, err)
        result = { ran_at: now.toISOString(), assigned: 0, per_agent: {}, reason: 'error' }
      }
      await db.from('accounts').update({ auto_assign_once_result: result }).eq('id', account.id)
    }
  } catch (err) {
    console.error('[scheduled assign] sweep failed:', err)
  }
  return { assigned }
}
