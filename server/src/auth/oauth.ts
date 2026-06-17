import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { forbidden, unauthorized } from '../lib/errors';

const client = new OAuth2Client({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
});

export interface GoogleProfile {
  email: string;
  name: string;
  picture?: string;
  hd?: string;
}

/** Build the Google consent URL. `state` is an anti-CSRF token we verify on callback. */
export function buildAuthUrl(state: string): string {
  return client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
    // Hint Google to the workspace domain (UX only — never trusted for access control).
    hd: env.ALLOWED_DOMAINS.length === 1 ? env.ALLOWED_DOMAINS[0] : undefined,
  });
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * Exchange an authorization code for tokens, cryptographically verify the ID
 * token, and enforce the Monks domain.
 *
 * Access control checks (all required):
 *  - ID token signature verified against Google's keys, audience = our client id
 *  - email is present and verified
 *  - the `hd` (hosted-domain) claim is one of ALLOWED_DOMAINS
 *  - the email's own domain is one of ALLOWED_DOMAINS
 *
 * We never trust the raw email string alone — personal accounts can spoof a
 * display name but cannot forge a verified `hd` claim on a signed token.
 */
export async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw unauthorized('Google did not return an ID token');
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw unauthorized('Could not read identity from Google');
  }

  const email = payload.email.toLowerCase();
  const allowed = new Set(env.ALLOWED_DOMAINS);
  const hd = payload.hd?.toLowerCase();

  if (!payload.email_verified) {
    throw forbidden('Your Google email is not verified');
  }
  if (!hd || !allowed.has(hd)) {
    throw forbidden('Access is restricted to the Monks Google Workspace');
  }
  if (!allowed.has(emailDomain(email))) {
    throw forbidden('Access is restricted to the Monks Google Workspace');
  }

  return {
    email,
    name: payload.name ?? email,
    picture: payload.picture,
    hd,
  };
}
