-- ============================================================
-- 049_lead_intake_conversion.sql — outcome of reporting a lead to Meta
--
-- A lead whose chat started from a click-to-WhatsApp ad is reported back
-- to Meta (Conversions API, through Zernio) once it reaches the CRM. The
-- outcome is kept on the intake:
--
--   { status: 'sent' | 'failed' | 'skipped', at, reason?, trace_id? }
--
-- NULL = not attempted yet. It never affects the intake's own status.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE lead_intakes
  ADD COLUMN IF NOT EXISTS conversion jsonb;

COMMENT ON COLUMN lead_intakes.conversion IS
  'Result of reporting this lead to Meta as a LeadSubmitted conversion (sent / failed / skipped, with the reason). NULL = not attempted.';
