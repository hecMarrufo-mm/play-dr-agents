import type { Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import type { AuthedUser } from './middleware';

/**
 * Identity-Aware Proxy (IAP) integration.
 *
 * In production the Cloud Run service sits behind IAP (Google authenticates the
 * user at the edge; only the IAP service agent can invoke the service). IAP then
 * forwards each request with a signed assertion header. We trust that identity
 * to provision/resolve the app user — no second OAuth handshake.
 *
 * Two trust modes:
 *  - IAP_AUDIENCE set  → cryptographically verify the `x-goog-iap-jwt-assertion`
 *    JWT (signature + issuer + audience) and read the email from it.
 *  - IAP_AUDIENCE empty → trust `x-goog-authenticated-user-email` (the service is
 *    not publicly invokable, so only IAP can set these headers).
 */
const iapClient = new OAuth2Client();

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

async function identityFromIap(req: Request): Promise<string | null> {
  const assertion = req.header('x-goog-iap-jwt-assertion');

  if (assertion && env.IAP_AUDIENCE) {
    try {
      const keys = await iapClient.getIapPublicKeys();
      const ticket = await iapClient.verifySignedJwtWithCertsAsync(
        assertion,
        keys.pubkeys,
        env.IAP_AUDIENCE,
        ['https://cloud.google.com/iap'],
      );
      const email = ticket.getPayload()?.email;
      return email ? email.toLowerCase() : null;
    } catch (err) {
      logger.warn('IAP JWT verification failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // Fallback: the IAP-set header, e.g. "accounts.google.com:user@monks.com".
  const header = req.header('x-goog-authenticated-user-email');
  if (header) {
    const email = header.split(':').pop()?.toLowerCase();
    if (email && email.includes('@')) return email;
  }
  return null;
}

/** Resolve (provisioning on first sight) the app user from the IAP identity, or null. */
export async function resolveIapUser(req: Request): Promise<AuthedUser | null> {
  if (!env.IAP_ENABLED) return null;

  const email = await identityFromIap(req);
  if (!email) return null;

  // IAP should already restrict to permitted members, but enforce the domain too.
  if (!new Set(env.ALLOWED_DOMAINS).has(emailDomain(email))) return null;

  const select = { id: true, email: true, name: true, avatarUrl: true, role: true } as const;
  const existing = await prisma.user.findUnique({ where: { email }, select });
  if (existing) return existing;

  const isAdmin = env.ADMIN_EMAILS.includes(email);
  logger.info('Provisioning user from IAP identity', { email });
  return prisma.user.create({
    data: { email, name: email, avatarUrl: null, role: isAdmin ? 'ADMIN' : 'USER' },
    select,
  });
}
