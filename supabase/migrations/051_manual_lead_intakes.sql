-- ============================================================
-- 051_manual_lead_intakes.sql — leads an agent sends by hand
--
-- A conversation that stalled before the AI could close the interview can
-- be finished by a person from the inbox (/enviarZoho or the "Send to
-- CRM" button): the app proposes the lead from the chat as a DRAFT, the
-- agent reviews and edits it, and on confirming it is delivered exactly
-- like an AI-captured one.
--
--   source              'ai' (default, today's rows) or 'manual'
--   created_by_user_id  the agent who sent it (manual only)
--   draft               the proposed lead, kept server-side so the
--                       data-processing consent flag cannot be forged by
--                       the browser
--   status 'draft'      proposed, not sent; never retried
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE lead_intakes
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS draft jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lead_intakes_source_check'
      AND conrelid = 'lead_intakes'::regclass
  ) THEN
    ALTER TABLE lead_intakes
      ADD CONSTRAINT lead_intakes_source_check CHECK (source IN ('ai', 'manual'));
  END IF;
END $$;

ALTER TABLE lead_intakes DROP CONSTRAINT IF EXISTS lead_intakes_status_check;
ALTER TABLE lead_intakes
  ADD CONSTRAINT lead_intakes_status_check
  CHECK (status IN ('pending', 'delivered', 'failed', 'no_endpoint',
                    'incomplete', 'no_consent', 'draft'));

COMMENT ON COLUMN lead_intakes.source IS
  'ai = captured by the auto-reply agent; manual = proposed and sent by an agent from the inbox.';
COMMENT ON COLUMN lead_intakes.draft IS
  'Manual intakes: the lead proposed from the chat ({ lead }), kept server-side until the agent confirms.';
