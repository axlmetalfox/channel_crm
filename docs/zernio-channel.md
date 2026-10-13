# WhatsApp through Zernio

An account can use [Zernio](https://zernio.com) as its WhatsApp channel
instead of its own Meta app. Zernio holds the WhatsApp Business account
and the number; wacrm receives customer messages from it by webhook and
sends replies through its REST API.

Accounts without a Zernio connection are unaffected and keep using the
Meta Cloud API.

## Connect

1. In the Zernio dashboard, connect the WhatsApp number (Connections →
   WhatsApp) and create an API key (API keys). Copy the **account ID** of
   the WhatsApp connection.
2. In wacrm: Settings → WhatsApp → *WhatsApp through Zernio*. Paste the
   account ID and the API key and press **Connect**.

wacrm checks the key and the account against Zernio, registers its webhook
there (`POST /v1/webhooks/settings`, scoped to that account, signed with a
secret wacrm generates), and stores the key and the secret encrypted
(AES-256-GCM, same as every other credential). The key is never shown
again. The server needs `NEXT_PUBLIC_SITE_URL` set to its public https URL.

## How it works

| Direction | Mechanism |
| --- | --- |
| Inbound | `POST /api/zernio/webhook/{token}`. `{token}` identifies the account; `X-Zernio-Signature` (HMAC-SHA256 hex of the raw body) proves it is Zernio. Replies 2xx immediately and processes in `after()`. |
| Events used | `message.received`, `message.delivered`, `message.read`, `message.failed` |
| Outbound | `POST /v1/inbox/conversations/{id}/messages` with `{accountId, message}`. Replies are addressed to the Zernio conversation id saved on `conversations.zernio_conversation_id` from the customer's last inbound message. |
| Idempotency | Delivery is at-least-once. Inbound messages are stored with an upsert on `(conversation_id, message_id)`; a replay is a no-op. |

An inbound message goes through the same pipeline as a Meta one: contact and
conversation are found or created, then flows, automations, the AI agent
(including lead capture) and the public `message.received` webhook run.

## Current limits

- Text only for sending. AI replies, flows' text messages and automation
  text messages use Zernio; templates, interactive messages and media sends
  still require Meta. Agents' manual replies from the inbox are not wired to
  Zernio yet.
- Inbound attachments are stored with their Zernio URL (no mirroring).
- Free-form replies are only possible inside WhatsApp's 24 h window, which
  is always the case for a reply to an inbound message.
- Disconnecting in wacrm does not delete the webhook endpoint at Zernio;
  remove it in the Zernio dashboard. wacrm answers it with 404 meanwhile.

## Operations

- `ZERNIO_API_BASE` overrides the API root (default
  `https://zernio.com/api/v1`; https only).
- Zernio's account-health endpoint reports whether Meta delivers inbound
  messages to Zernio (`platformConnection.inboundWebhookSubscribed`); the
  settings card warns when it is `false`.
