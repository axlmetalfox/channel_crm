-- ============================================================
-- 053_consent_notice.sql — data-processing notice sent first
--
-- Instead of asking "do you authorize...?" in the middle of the interview
-- (friction that loses leads), the account can have the system send a
-- fixed notice as the FIRST message of a conversation, for example:
--
--   "Al continuar, confirmas que conoces y aceptas la Política de
--    Tratamiento de Datos Personales de INTERTEC SAS. Puedes consultarla
--    aquí: https://…"
--
-- Continuing the conversation after it is the acceptance, so a lead from
-- a chat that contains the notice counts as authorized. NULL = no notice
-- (the AI asks for authorization as its instructions say).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS consent_notice text;

COMMENT ON COLUMN ai_configs.consent_notice IS
  'Fixed data-processing notice sent as the first message of a conversation; continuing the chat is the acceptance. NULL = none.';
