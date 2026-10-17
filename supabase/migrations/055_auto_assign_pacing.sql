-- ============================================================
-- 055_auto_assign_pacing.sql — hand stalled conversations out gently
--
-- Migration 052 hands stalled conversations to the team in turns. When
-- the office opens after a night or a weekend, everything that went quiet
-- meanwhile would land on the team at once. Three guards, plus a way to
-- take an agent out of the rotation:
--
--   auto_assign_max_age_days      only conversations with activity within
--                                 this many days are handed out (older
--                                 ones are left alone)
--   auto_assign_batch_per_agent   most conversations one agent receives
--                                 per sweep (about every 5 minutes)
--   profiles.available_for_assignment
--                                 false = this agent is skipped by the
--                                 rotation (away, on leave)
--
-- The inactivity clock also starts when the working hours start (see
-- src/lib/conversations/auto-assign.ts), so the team gets the wait too.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_assign_max_age_days integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS auto_assign_batch_per_agent integer NOT NULL DEFAULT 3;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_auto_assign_max_age_days_check'
                 AND conrelid = 'accounts'::regclass) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_auto_assign_max_age_days_check
      CHECK (auto_assign_max_age_days BETWEEN 1 AND 90);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_auto_assign_batch_per_agent_check'
                 AND conrelid = 'accounts'::regclass) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_auto_assign_batch_per_agent_check
      CHECK (auto_assign_batch_per_agent BETWEEN 1 AND 50);
  END IF;
END $$;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS available_for_assignment boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN accounts.auto_assign_max_age_days IS
  'Automatic assignment only hands out conversations with activity within this many days.';
COMMENT ON COLUMN accounts.auto_assign_batch_per_agent IS
  'Most conversations one agent receives per automatic-assignment sweep.';
COMMENT ON COLUMN profiles.available_for_assignment IS
  'false = skipped by the automatic round-robin assignment (agent away or on leave).';
