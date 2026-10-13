import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify a Zernio webhook delivery.
 *
 * Zernio signs the raw request body with HMAC-SHA256 (lowercase hex),
 * keyed by the secret we chose when registering the endpoint, and sends
 * it in `X-Zernio-Signature`. The comparison is constant-time and uses
 * the raw body exactly as received — a re-serialised copy would not
 * match.
 */
export function verifyZernioSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header || !secret) return false
  const presented = header.trim().toLowerCase().replace(/^sha256=/, '')
  if (!/^[0-9a-f]{64}$/.test(presented)) return false

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented))
}

/** Build the header value for `rawBody` (used by tests and local tools). */
export function signZernioBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}
