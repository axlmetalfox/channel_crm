// ============================================================
// A message that is only a link to someone else's social-media post.
//
// People share reels and posts to a WhatsApp number by mistake or out of
// habit (the share sheet offers every chat they have had). Such a message
// says nothing to the business, and answering it opens a conversation
// nobody is going to continue. The agent stays silent for one that is
// the first thing a person ever sends.
// ============================================================

/** Hosts whose links are shared posts / videos, matched by suffix. */
const SOCIAL_HOSTS = [
  'facebook.com',
  'fb.watch',
  'fb.com',
  'instagram.com',
  'instagr.am',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'threads.net',
  'pinterest.com',
  'pin.it',
]

/**
 * True when the whole message is a single link to a social network
 * (nothing else typed). `fb.me` is deliberately left out: Meta uses it for
 * the ad links that open a chat from an Intertec ad.
 */
export function isSocialShareOnly(text: string | null | undefined): boolean {
  const trimmed = text?.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  return SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}
