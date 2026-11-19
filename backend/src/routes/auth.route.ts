import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../lib/prisma';
import { parseCookies } from '../middleware/auth.middleware';

const router = Router();

export const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-memory fallback map (in addition to durable signed cookie and database storage)
export interface OAuthStateEntry {
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}
export const oauthStateMap = new Map<string, OAuthStateEntry>();

function cleanupExpiredMemoryStates(): void {
  const now = Date.now();
  for (const [key, entry] of oauthStateMap) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      oauthStateMap.delete(key);
    }
  }
}

const memoryCleanupInterval = setInterval(cleanupExpiredMemoryStates, 5 * 60 * 1000);
if (memoryCleanupInterval.unref) {
  memoryCleanupInterval.unref();
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

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: In production mode, SESSION_SECRET must be configured.');
    }
    return 'leadsync-default-hmac-sha256-secret-key-32chars';
  }
  return secret;
}

export function createOAuth2Client(): OAuth2Client {
  return new OAuth2Client({
    clientId: getGoogleClientId(),
    clientSecret: getGoogleClientSecret(),
    redirectUri: getGoogleRedirectUri(),
  });
}

/**
 * Signs OAuth state payload for durable, stateless cookie persistence
 * across server restarts and horizontally scaled backend instances.
 */
export function signOAuthCookiePayload(payload: {
  state: string;
  nonce: string;
  codeVerifier: string;
  exp: number;
}): string {
  const secret = getSessionSecret();
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyOAuthCookiePayload(cookieVal: string): {
  state: string;
  nonce: string;
  codeVerifier: string;
  exp: number;
} | null {
  if (!cookieVal || !cookieVal.includes('.')) return null;
  const [data, sig] = cookieVal.split('.');
  if (!data || !sig) return null;

  const secret = getSessionSecret();
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');

  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!parsed.state || !parsed.nonce || !parsed.codeVerifier || !parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Saves OAuth state durably across database, signed HttpOnly cookie, and in-memory cache.
 */
export async function persistOAuthState(
  res: Response,
  entry: { state: string; nonce: string; codeVerifier: string }
): Promise<void> {
  const exp = Date.now() + STATE_TTL_MS;

  // 1. In-memory cache
  oauthStateMap.set(entry.state, {
    nonce: entry.nonce,
    codeVerifier: entry.codeVerifier,
    createdAt: Date.now(),
  });

  // 2. Durable Signed HttpOnly Cookie (survives backend restarts / multi-instance scaling)
  const signedCookie = signOAuthCookiePayload({
    state: entry.state,
    nonce: entry.nonce,
    codeVerifier: entry.codeVerifier,
    exp,
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const cookieHeaders = [
    `leadsync_oauth_state=${signedCookie}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=600`, // 10 minutes
    'SameSite=Lax',
  ];
  if (isProduction) {
    cookieHeaders.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieHeaders.join('; '));

  // 3. Database persistence (if DB is reachable)
  try {
    await prisma.oAuthState.create({
      data: {
        state: entry.state,
        nonce: entry.nonce,
        codeVerifier: entry.codeVerifier,
        expiresAt: new Date(exp),
      },
    });
  } catch {
    // If DB is offline, signed cookie and memory store ensure uninterrupted flow
  }
}

/**
 * Retrieves and atomically consumes the OAuth state, preventing replay attacks.
 */
export async function consumeOAuthState(
  req: Request,
  res: Response,
  state: string
): Promise<{ nonce: string; codeVerifier: string } | 'expired' | null> {
  // Clear the OAuth state cookie immediately to prevent replay
  const isProduction = process.env.NODE_ENV === 'production';
  const clearCookieParts = [
    'leadsync_oauth_state=',
    'HttpOnly',
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
  ];
  if (isProduction) {
    clearCookieParts.push('Secure');
  }
  res.setHeader('Set-Cookie', clearCookieParts.join('; '));

  // 1. Try reading from signed HttpOnly cookie
  const cookies = parseCookies(req.headers.cookie);
  const cookieVal = cookies['leadsync_oauth_state'];
  if (cookieVal) {
    const verified = verifyOAuthCookiePayload(cookieVal);
    if (verified && verified.state === state) {
      // Also delete from DB & memory
      oauthStateMap.delete(state);
      try {
        await prisma.oAuthState.deleteMany({ where: { state } }).catch(() => {});
      } catch {}

      if (Date.now() > verified.exp) {
        return 'expired';
      }
      return { nonce: verified.nonce, codeVerifier: verified.codeVerifier };
    }
  }

  // 2. Try reading from Database
  try {
    const dbEntry = await prisma.oAuthState.findUnique({ where: { state } });
    if (dbEntry) {
      await prisma.oAuthState.deleteMany({ where: { state } }).catch(() => {});
      oauthStateMap.delete(state);

      if (Date.now() > dbEntry.expiresAt.getTime()) {
        return 'expired';
      }
      return { nonce: dbEntry.nonce, codeVerifier: dbEntry.codeVerifier };
    }
  } catch {}

  // 3. Try reading from memory store
  const memEntry = oauthStateMap.get(state);
  if (memEntry) {
    oauthStateMap.delete(state);
    if (Date.now() - memEntry.createdAt > STATE_TTL_MS) {
      return 'expired';
    }
    return { nonce: memEntry.nonce, codeVerifier: memEntry.codeVerifier };
  }

  return null;
}

// --- Routes ---

/**
 * GET /api/auth/google
 * Initiates Google OAuth2 flow with PKCE, nonce, and durable state.
 */
router.get('/google', async (_req: Request, res: Response): Promise<void> => {
  try {
    const clientId = getGoogleClientId();
    const redirectUri = getGoogleRedirectUri();

    // Generate random state, nonce, and PKCE code_verifier
    const state = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url'); // 43 chars RFC 7636
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // Persist state durably (signed cookie + database + memory)
    await persistOAuthState(res, { state, nonce, codeVerifier });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
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
 * Validates state, exchanges code with PKCE code_verifier, strictly verifies nonce,
 * checks owner identity, and establishes an HttpOnly session.
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

    // Validate state parameter
    if (!state || typeof state !== 'string') {
      res.redirect(`${appOrigin}/?auth_error=invalid_state`);
      return;
    }

    // Retrieve and consume durable state
    const stateResult = await consumeOAuthState(req, res, state);
    if (!stateResult || stateResult === null) {
      res.redirect(`${appOrigin}/?auth_error=invalid_state`);
      return;
    }

    if (stateResult === 'expired') {
      res.redirect(`${appOrigin}/?auth_error=expired_state`);
      return;
    }

    if (!code || typeof code !== 'string') {
      res.redirect(`${appOrigin}/?auth_error=missing_code`);
      return;
    }

    // Exchange code for tokens using PKCE code_verifier
    const clientId = getGoogleClientId();
    const client = createOAuth2Client();

    const { tokens } = await client.getToken({
      code,
      codeVerifier: stateResult.codeVerifier,
    });

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

    // MANDATORY EXACT NONCE MATCH (Non-conditional)
    if (!payload.nonce || payload.nonce !== stateResult.nonce) {
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
