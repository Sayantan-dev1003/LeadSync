import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../lib/prisma';
import { parseCookies } from '../middleware/auth.middleware';

const router = Router();

// --- OAuth state/nonce store with TTL cleanup ---
export interface OAuthStateEntry {
  nonce: string;
  createdAt: number;
}

export const oauthStateMap = new Map<string, OAuthStateEntry>();
export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [key, entry] of oauthStateMap) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      oauthStateMap.delete(key);
    }
  }
}

// Run cleanup every 5 minutes
const cleanupInterval = setInterval(cleanupExpiredStates, 5 * 60 * 1000);
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

// --- Environment helpers ---
export function getGoogleClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error('GOOGLE_CLIENT_ID is not configured');
  return id;
}

export function getGoogleClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error('GOOGLE_CLIENT_SECRET is not configured');
  return secret;
}

export function getGoogleRedirectUri(): string {
  return process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback';
}

export function getAppOrigin(): string {
  return process.env.APP_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';
}

export function getOwnerEmail(): string {
  const email = process.env.OWNER_GOOGLE_EMAIL;
  if (!email) throw new Error('OWNER_GOOGLE_EMAIL is not configured');
  return email;
}

// Exportable OAuth2 client factory for easy mocking in unit tests
export function createOAuth2Client(): OAuth2Client {
  return new OAuth2Client({
    clientId: getGoogleClientId(),
    clientSecret: getGoogleClientSecret(),
    redirectUri: getGoogleRedirectUri(),
  });
}

// --- Routes ---

/**
 * GET /api/auth/google
 * Initiates Google OAuth2 flow by redirecting to Google's consent / account selection screen.
 */
router.get('/google', (_req: Request, res: Response): void => {
  try {
    const clientId = getGoogleClientId();
    const redirectUri = getGoogleRedirectUri();

    const state = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');

    oauthStateMap.set(state, { nonce, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      access_type: 'offline',
      prompt: 'select_account',
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    console.error('Failed to initiate Google OAuth:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to initiate authentication' });
  }
});

/**
 * GET /api/auth/google/callback
 * Handles the OAuth2 callback from Google.
 * Validates state, exchanges authorization code for tokens, verifies ID token,
 * verifies owner identity, and creates an application session.
 */
router.get('/google/callback', async (req: Request, res: Response): Promise<void> => {
  const appOrigin = getAppOrigin();

  try {
    const { code, state, error } = req.query;

    // User denied consent or Google returned error
    if (error) {
      res.redirect(`${appOrigin}/?auth_error=denied`);
      return;
    }

    // Validate state parameter (CSRF protection)
    if (!state || typeof state !== 'string') {
      res.redirect(`${appOrigin}/?auth_error=invalid_state`);
      return;
    }

    const storedEntry = oauthStateMap.get(state);
    if (!storedEntry) {
      res.redirect(`${appOrigin}/?auth_error=invalid_state`);
      return;
    }

    // Remove state immediately to prevent replay attacks
    oauthStateMap.delete(state);

    // Check if state has expired
    if (Date.now() - storedEntry.createdAt > STATE_TTL_MS) {
      res.redirect(`${appOrigin}/?auth_error=expired_state`);
      return;
    }

    if (!code || typeof code !== 'string') {
      res.redirect(`${appOrigin}/?auth_error=missing_code`);
      return;
    }

    // Exchange code for tokens
    const clientId = getGoogleClientId();
    const client = createOAuth2Client();

    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      res.redirect(`${appOrigin}/?auth_error=no_id_token`);
      return;
    }

    // Verify ID token
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientId,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      res.redirect(`${appOrigin}/?auth_error=invalid_token`);
      return;
    }

    // Validate issuer
    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!payload.iss || !validIssuers.includes(payload.iss)) {
      res.redirect(`${appOrigin}/?auth_error=invalid_issuer`);
      return;
    }

    // Validate email_verified
    if (!payload.email_verified) {
      res.redirect(`${appOrigin}/?auth_error=email_not_verified`);
      return;
    }

    // Validate nonce
    if (payload.nonce && payload.nonce !== storedEntry.nonce) {
      res.redirect(`${appOrigin}/?auth_error=invalid_nonce`);
      return;
    }

    const email = payload.email;
    const sub = payload.sub;

    if (!email || !sub) {
      res.redirect(`${appOrigin}/?auth_error=missing_claims`);
      return;
    }

    // Check if this is the authorized owner
    const ownerEmail = getOwnerEmail();
    if (email.toLowerCase() !== ownerEmail.toLowerCase()) {
      res.redirect(`${appOrigin}/?auth_error=unauthorized`);
      return;
    }

    // If OWNER_GOOGLE_SUB is set, also validate sub
    const ownerSub = process.env.OWNER_GOOGLE_SUB;
    if (ownerSub && sub !== ownerSub) {
      res.redirect(`${appOrigin}/?auth_error=unauthorized`);
      return;
    }

    // Authorized! Create session.
    const sessionToken = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await prisma.session.create({
      data: {
        sessionToken,
        googleSub: sub,
        email,
        name: payload.name || null,
        picture: payload.picture || null,
        expiresAt,
      },
    });

    // Set session cookie
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieParts = [
      `leadsync_session=${sessionToken}`,
      'HttpOnly',
      'Path=/',
      `Max-Age=${7 * 24 * 60 * 60}`,
      'SameSite=Lax',
    ];
    if (isProduction) {
      cookieParts.push('Secure');
    }

    res.setHeader('Set-Cookie', cookieParts.join('; '));
    res.redirect(`${appOrigin}/`);
  } catch (err) {
    console.error('Google OAuth callback error:', err instanceof Error ? err.message : err);
    res.redirect(`${appOrigin}/?auth_error=server_error`);
  }
});

/**
 * GET /api/auth/me
 * Returns the current user's session info, or { authenticated: false }.
 */
router.get('/me', async (req: Request, res: Response): Promise<void> => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['leadsync_session'];

    if (!token) {
      res.json({ authenticated: false });
      return;
    }

    const session = await prisma.session.findUnique({
      where: { sessionToken: token },
    });

    if (!session || new Date() > session.expiresAt) {
      if (session) {
        await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      }
      res.json({ authenticated: false });
      return;
    }

    // Verify against configured owner email/sub
    const ownerEmail = process.env.OWNER_GOOGLE_EMAIL;
    const ownerSub = process.env.OWNER_GOOGLE_SUB;
    if (ownerEmail && session.email.toLowerCase() !== ownerEmail.toLowerCase()) {
      res.json({ authenticated: false });
      return;
    }
    if (ownerSub && session.googleSub !== ownerSub) {
      res.json({ authenticated: false });
      return;
    }

    res.json({
      authenticated: true,
      user: {
        email: session.email,
        name: session.name,
        picture: session.picture,
      },
    });
  } catch (err) {
    console.error('Auth me error:', err instanceof Error ? err.message : err);
    res.json({ authenticated: false });
  }
});

/**
 * POST /api/auth/logout
 * Destroys the current session and clears the cookie.
 */
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['leadsync_session'];

    if (token) {
      await prisma.session.deleteMany({ where: { sessionToken: token } }).catch(() => {});
    }

    // Clear the cookie
    const cookieParts = [
      'leadsync_session=',
      'HttpOnly',
      'Path=/',
      'Max-Age=0',
      'SameSite=Lax',
    ];
    if (process.env.NODE_ENV === 'production') {
      cookieParts.push('Secure');
    }

    res.setHeader('Set-Cookie', cookieParts.join('; '));
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

export default router;
