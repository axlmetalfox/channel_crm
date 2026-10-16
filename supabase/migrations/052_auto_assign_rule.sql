-- ============================================================
-- 052_auto_assign_rule.sql — hand stalled conversations to a person
--
-- A conversation the AI agent started but nobody finished (the customer
-- went quiet mid-interview) can be handed to the human team after a
-- period of inactivity, taking the agents in turns (round robin).
--
--   auto_assign_enabled        the rule is on
--   auto_assign_after_minutes  inactivity before assigning (5 .. 43200)
--   auto_assign_cursor         the agent who got the last one; the next
--                              conversation goes to the agent after them
--
-- The cron route /api/conversations/sweep applies it. While the AI is on
-- duty (per ai_configs.auto_reply_schedule) nobody is at the desks, so
-- nothing is assigned then. Assigning a conversation stops the AI agent
-- from answering it: a person owns it from then on.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_assign_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_assign_after_minutes integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS auto_assign_cursor uuid REFERENCES auth.users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_auto_assign_after_minutes_check'
      AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_auto_assign_after_minutes_check
      CHECK (auto_assign_after_minutes BETWEEN 5 AND 43200);
  END IF;
END $$;

COMMENT ON COLUMN accounts.auto_assign_enabled IS
  'When true, conversations idle for auto_assign_after_minutes are assigned to the agents in turns (round robin).';
COMMENT ON COLUMN accounts.auto_assign_cursor IS
  'The agent who received the last automatic assignment; the next one goes to the following agent.';
