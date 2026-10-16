// ============================================================
// POST /api/invitations/[token]/signup
//
// Create an account for someone holding a valid invitation link, on
// instances where public sign-up is closed (the Supabase Auth setting
// DISABLE_SIGNUP, which is how a private deployment keeps strangers
// from registering).
//
// The invitation link is the credential: it is a 256-bit secret that
// the account's admin handed to this person, and redeeming it already
// grants membership. So a valid, unused, unexpired link is allowed to
// create the one user that will redeem it. Nothing else is: without a
// valid token this route creates nothing.
//
// The account is created already confirmed (holding the link, which an
// admin sent to the person, stands in for the verification email). The
// client then signs in and accepts the invitation on /join/<token>,
// where the existing redeem step moves the new user into the inviter's
// account.
//
// Errors carry a stable `code` the page maps to a translated message.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { hashInviteToken } from '@/lib/auth/invitations'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

const fail = (code: string, status: number, error: string) =>
  NextResponse.json({ error, code }, { status })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(`invite-signup:${getClientIp(request)}`, RATE_LIMITS.invitationSignup)
  if (!limit.success) return rateLimitResponse(limit)

  const { token } = await params
  if (!token || typeof token !== 'string') {
    return fail('invalid_invite', 400, 'Missing invitation token')
  }

  let body: { full_name?: unknown; email?: unknown; password?: unknown }
  try {
    body = await request.json()
  } catch {
    return fail('invalid_input', 400, 'Invalid JSON')
  }
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (
    !fullName ||
    fullName.length > 120 ||
    !EMAIL_RE.test(email) ||
    email.length > 254 ||
    password.length < 6 ||
    password.length > 72
  ) {
    return fail('invalid_input', 400, 'Check the name, email and password (6+ characters)')
  }

  const admin = supabaseAdmin()

  // Only a link that can still be redeemed may create an account.
  const { data: peek, error: peekError } = await admin.rpc('peek_invitation', {
    p_token_hash: hashInviteToken(token),
  })
  if (peekError) {
    console.error('[invite signup] peek failed:', peekError)
    return fail('failed', 500, 'Could not check the invitation')
  }
  if (!peek || (peek as { ok?: boolean }).ok !== true) {
    return fail('invalid_invite', 400, 'This invitation is not valid anymore')
  }

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (error) {
    const exists =
      error.code === 'email_exists' || /already (been )?registered|already exists/i.test(error.message)
    if (exists) {
      return fail('email_exists', 409, 'An account with this email already exists')
    }
    console.error('[invite signup] createUser failed:', error)
    return fail('failed', 500, 'Could not create the account')
  }

  return NextResponse.json({ ok: true })
}
