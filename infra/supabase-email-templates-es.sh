#!/usr/bin/env bash
# Point Supabase Auth (GoTrue) at the Spanish email templates that the app
# serves from /email-templates/*.html, and set Spanish subjects.
#
# Run on the Supabase host, from the directory that holds docker-compose.yml:
#
#   cd /opt/supabase/supabase-src/docker
#   APP_URL=https://intertec.tuyoapps.cloud bash supabase-email-templates-es.sh
#   docker compose up -d auth
#
# It edits docker-compose.yml (a timestamped backup is kept next to it) and
# is idempotent: running it twice does not duplicate the lines.
set -euo pipefail

APP_URL="${APP_URL:?set APP_URL to the public https URL of the app, e.g. https://intertec.tuyoapps.cloud}"
COMPOSE="${COMPOSE:-docker-compose.yml}"
ANCHOR='GOTRUE_SMTP_SENDER_NAME:'

emit_block() {
  cat <<EOF
      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: ${APP_URL}/email-templates/confirmation.html
      GOTRUE_MAILER_TEMPLATES_RECOVERY: ${APP_URL}/email-templates/recovery.html
      GOTRUE_MAILER_TEMPLATES_INVITE: ${APP_URL}/email-templates/invite.html
      GOTRUE_MAILER_TEMPLATES_MAGIC_LINK: ${APP_URL}/email-templates/magic_link.html
      GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE: ${APP_URL}/email-templates/email_change.html
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: "Confirma tu correo en TUYO CRM"
      GOTRUE_MAILER_SUBJECTS_RECOVERY: "Restablece tu contraseña de TUYO CRM"
      GOTRUE_MAILER_SUBJECTS_INVITE: "Te invitaron a TUYO CRM"
      GOTRUE_MAILER_SUBJECTS_MAGIC_LINK: "Tu enlace de acceso a TUYO CRM"
      GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE: "Confirma el cambio de correo en TUYO CRM"
EOF
}

if ! grep -q "$ANCHOR" "$COMPOSE"; then
  echo "Could not find $ANCHOR in $COMPOSE; aborting." >&2
  exit 1
fi
if grep -q 'GOTRUE_MAILER_TEMPLATES_RECOVERY' "$COMPOSE"; then
  echo "Templates are already configured in $COMPOSE; nothing to do."
  exit 0
fi

cp "$COMPOSE" "$COMPOSE.bak-templates-$(date +%Y%m%d%H%M%S)"

BLOCK_FILE="$(mktemp)"
emit_block > "$BLOCK_FILE"

# Insert the block right after the SMTP sender name line of the auth service.
awk -v blockfile="$BLOCK_FILE" -v anchor="$ANCHOR" '
  { print }
  index($0, anchor) && !done {
    while ((getline line < blockfile) > 0) print line
    done = 1
  }
' "$COMPOSE" > "$COMPOSE.new"
cat "$COMPOSE.new" > "$COMPOSE"
rm -f "$COMPOSE.new" "$BLOCK_FILE"

echo "Done. Now run: docker compose up -d auth"
grep -n 'GOTRUE_MAILER_\(TEMPLATES\|SUBJECTS\)' "$COMPOSE"
