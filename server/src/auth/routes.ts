import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest } from '../lib/errors';
import { logger } from '../lib/logger';
import { buildAuthUrl, exchangeCodeForProfile } from './oauth';
import { clearSession, issueSession } from './session';
import { loadUser } from './middleware';

const STATE_COOKIE = 'cb_oauth_state';
const STATE_PATH = '/api/auth';

const router = Router();

/** Begin the OAuth handshake: set an anti-CSRF state cookie and redirect to Google. */
router.get('/google', (_req, res) => {
  const state = randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: STATE_PATH,
  });
  res.redirect(buildAuthUrl(state));
});

/** OAuth redirect target: verify state + ID token, provision the user, issue a session. */
router.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;
    const loginUrl = `${env.APP_BASE_URL}/login`;

    if (error) {
      return res.redirect(`${loginUrl}?error=${encodeURIComponent(String(error))}`);
    }

    const cookieState = req.cookies?.[STATE_COOKIE];
    if (typeof code !== 'string' || typeof state !== 'string' || !cookieState || state !== cookieState) {
      throw badRequest('Invalid or missing OAuth state');
    }
    res.clearCookie(STATE_COOKIE, { path: STATE_PATH });

    let profile;
    try {
      profile = await exchangeCodeForProfile(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed';
      logger.warn('OAuth sign-in rejected', { message });
      return res.redirect(`${loginUrl}?error=${encodeURIComponent(message)}`);
    }

    // First-login provisioning: anyone in an allowed domain gets a default account.
    const isAdmin = env.ADMIN_EMAILS.includes(profile.email);
    const user = await prisma.user.upsert({
      where: { email: profile.email },
      update: { name: profile.name, avatarUrl: profile.picture ?? null },
      create: {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.picture ?? null,
        role: isAdmin ? 'ADMIN' : 'USER',
      },
    });
    // Keep allowlisted admins elevated even if their account predates the allowlist.
    if (isAdmin && user.role !== 'ADMIN') {
      await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    }

    issueSession(res, user.id);
    logger.info('User signed in', { email: user.email });
    return res.redirect(env.APP_BASE_URL);
  }),
);

router.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

/** Current user, or { user: null } when not signed in. Intentionally not guarded. */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = await loadUser(req);
    // `iap` tells the client to route sign-out through IAP instead of app logout.
    res.json({ user, iap: env.IAP_ENABLED });
  }),
);

export default router;
