import type { SupabaseClient } from '@supabase/supabase-js'
import { isOnDuty, parseSchedule } from '@/lib/ai/schedule'
import { loadZernioConfig } from '@/lib/zernio/config'
import { engineSendText } from '@/lib/flows/meta-send'

// ============================================================
// The recovery message.
//
// When the agent asked a customer something and they went quiet, the
// account's admin can have it send one short message to bring them back
// ("Estoy muy atento para ayudarte a completar tu requerimiento").
//
// Rules that keep it polite and allowed:
//   - one nudge per silence (conversations.recovery_nudge_at);
//   - only inside WhatsApp's free-text window (the customer's last message
//     less than ~24 h old; the wait setting is capped at 23 h);
//   - only when the agent's last message asked something (it holds a "?"),
//     so a goodbye is never followed by "I am attentive to help you";
//   - only while the AI agent is on duty and never at night
//     (21:00-07:00 in the schedule's time zone, Bogotá by default);
//   - never in a conversation a person owns.
// ============================================================

/** Customer's last message must be younger than this: a little under 24 h. */
const WINDOW_MINUTES = 23 * 60 + 45
/** Most nudges one account sends per sweep. */
const MAX_PER_RUN = 20
const QUIET_FROM_HOUR = 21
const QUIET_UNTIL_HOUR = 7
const DEFAULT_TIMEZONE = 'America/Bogota'

/** Hour of day (0-23) at `at` in `timezone`. */
function localHour(at: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(at)
    .find((p) => p.type === 'hour')?.value
  return Number(h)
}

/** Night-time: nobody should get a nudge between 21:00 and 07:00. */
export function isQuietHour(at: Date, timezone: string = DEFAULT_TIMEZONE): boolean {
  const hour = localHour(at, timezone)
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR
}

interface RecoveryRule {
  account_id: string
  recovery_after_minutes: number
  recovery_message: string
  auto_reply_schedule: unknown
}

interface Candidate {
  conversation_id: string
  contact_id: string
  previous_nudge_at: string | null
}

/**
 * Send the due recovery messages of every account that switched them on.
 * Never throws; returns how many were sent.
 */
export async function runRecoveryNudges(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ sent: number }> {
  let sent = 0
  try {
    const { data: rules } = await db
      .from('ai_configs')
      .select('account_id, recovery_after_minutes, recovery_message, auto_reply_schedule')
      .eq('recovery_enabled', true)
      .not('recovery_message', 'is', null)

    for (const rule of (rules ?? []) as RecoveryRule[]) {
      try {
        sent += await nudgeAccount(db, rule, now)
      } catch (err) {
        console.error(`[recovery] account ${rule.account_id} failed:`, err)
      }
    }
  } catch (err) {
    console.error('[recovery] sweep failed:', err)
  }
  return { sent }
}

async function nudgeAccount(db: SupabaseClient, rule: RecoveryRule, now: Date): Promise<number> {
  const message = rule.recovery_message?.trim()
  if (!message) return 0

  // Only while the AI agent covers the account, and never at night.
  const parsed = parseSchedule(rule.auto_reply_schedule)
  const schedule = parsed && typeof parsed !== 'string' ? parsed : null
  if (schedule && !isOnDuty(schedule, now)) return 0
  if (isQuietHour(now, schedule?.timezone ?? DEFAULT_TIMEZONE)) return 0

  const zernio = await loadZernioConfig(db, rule.account_id)
  if (!zernio) return 0

  const { data } = await db.rpc('recovery_candidates', {
    p_account_id: rule.account_id,
    p_idle_minutes: rule.recovery_after_minutes,
    p_window_minutes: WINDOW_MINUTES,
    p_limit: MAX_PER_RUN,
  })

  let sent = 0
  for (const c of (data ?? []) as Candidate[]) {
    // Claim it first, so two overlapping sweeps cannot both send.
    const claim = db
      .from('conversations')
      .update({ recovery_nudge_at: now.toISOString() })
      .eq('id', c.conversation_id)
    const { data: claimed } = await (c.previous_nudge_at
      ? claim.eq('recovery_nudge_at', c.previous_nudge_at)
      : claim.is('recovery_nudge_at', null)
    ).select('id')
    if (!Array.isArray(claimed) || claimed.length === 0) continue

    try {
      await engineSendText({
        accountId: rule.account_id,
        userId: zernio.userId,
        conversationId: c.conversation_id,
        contactId: c.contact_id,
        text: message,
        aiGenerated: true,
      })
      sent += 1
    } catch (err) {
      console.error(`[recovery] send failed for ${c.conversation_id}:`, err)
      // Not delivered: give the claim back so the next sweep tries again.
      await db
        .from('conversations')
        .update({ recovery_nudge_at: c.previous_nudge_at })
        .eq('id', c.conversation_id)
    }
  }
  return sent
}
