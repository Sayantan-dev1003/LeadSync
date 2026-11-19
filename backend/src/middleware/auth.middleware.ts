import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';

export type UserRole = 'admin' | 'reviewer' | 'user' | 'owner';

export interface AuthUser {
  id: string;
  role: UserRole;
  email?: string;
  name?: string | null;
  picture?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

/**
 * Helper to parse cookies from the Cookie header.
 */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  });
  return cookies;
}

/**
 * Returns the authentication secret for token signing and verification.
 * Fails safely in production if neither AUTH_SECRET nor JWT_SECRET is configured.
 */
export function getAuthSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: In production mode, AUTH_SECRET or JWT_SECRET must be configured.');
    }
    return 'leadsync-default-hmac-sha256-secret-key-32chars';
  }
  return secret;
}

/**
 * Checks whether local development demo mode is explicitly enabled.
 * Strictly restricted to NODE_ENV === 'development' with explicit opt-in.
 * Never allowed in test or production environments.
 */
export function isDevDemoAuthEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'development' &&
    (process.env.ALLOW_DEV_ANONYMOUS === 'true' || process.env.ENABLE_DEV_DEMO_AUTH === 'true')
  );
}

// Deterministic fallback dev user for explicitly enabled local DX demo mode
export const DEFAULT_DEV_USER: AuthUser = {
  id: 'usr_dev_reviewer_01',
  role: 'owner',
  email: 'owner@leadsync.internal',
};

/**
 * Creates a signed JWT-style token (header.payload.signature) using native crypto.
 */
export function generateToken(
  user: { id: string; role?: UserRole; email?: string },
  expiresInHours: number = 24
): string {
  const secret = getAuthSecret();
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      role: user.role || 'user',
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + expiresInHours * 3600,
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Verifies and decodes a token. Returns null if invalid, expired, or signature mismatch.
 */
export function verifyToken(token: string): AuthUser | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let secret: string;
  try {
    secret = getAuthSecret();
  } catch {
    return null;
  }

  const [header, payload, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  // Constant-time comparison to prevent timing attacks
  if (signature.length !== expectedSignature.length) return null;
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.exp && Date.now() / 1000 > decoded.exp) {
      return null; // Expired
    }
    if (!decoded.id || !decoded.role) return null;
    return {
      id: decoded.id,
      role: decoded.role as UserRole,
      email: decoded.email,
    };
  } catch {
    return null;
  }
}

/**
 * CSRF protection middleware for state-changing requests.
 * Rejects requests with mismatched Origin/Referer headers.
 */
export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  // Safe methods do not mutate state
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const originHeader = req.headers.origin;
  const refererHeader = req.headers.referer;
  let requestOrigin: string | undefined = originHeader;

  if (!requestOrigin && refererHeader) {
    try {
      requestOrigin = new URL(refererHeader).origin;
    } catch {
      // Invalid referer URL format
    }
  }

  // If no Origin or Referer header was provided (e.g. direct server-to-server, curl, tests), proceed
  if (!requestOrigin) {
    return next();
  }

  const allowedOrigins = [
    process.env.APP_ORIGIN,
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://groweasy-frontend.vercel.app',
  ].filter(Boolean) as string[];

  const isAllowed = allowedOrigins.some((allowed) => {
    try {
      return new URL(allowed).origin === requestOrigin;
    } catch {
      return allowed === requestOrigin;
    }
  });

  if (!isAllowed) {
    res.status(403).json({ error: 'CSRF verification failed: Origin not allowed' });
    return;
  }

  next();
}

/**
 * Middleware that extracts credentials from:
 * 1. Session cookie (leadsync_session) -> resolves owner from database
 * 2. API Key header (x-api-key)
 * 3. Authorization Bearer token header
 * 4. Development demo fallback if explicitly enabled
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // 1. Session Cookie lookup
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies['leadsync_session'];

    if (sessionToken) {
      try {
        const session = await prisma.session.findUnique({
          where: { sessionToken },
        });

        if (session && new Date() <= session.expiresAt) {
          const ownerEmail = process.env.OWNER_GOOGLE_EMAIL;
          const ownerSub = process.env.OWNER_GOOGLE_SUB;
          const emailMatches = !ownerEmail || session.email.toLowerCase() === ownerEmail.toLowerCase();
          const subMatches = !ownerSub || session.googleSub === ownerSub;

          if (emailMatches && subMatches) {
            req.user = {
              id: session.googleSub,
              role: 'owner',
              email: session.email,
              name: session.name,
              picture: session.picture,
            };
            next();
            return;
          }
        }
      } catch {
        // If DB query fails, continue to check headers
      }
    }

    const authHeader = req.headers.authorization;
    const apiKey = req.headers['x-api-key'] as string | undefined;

    // 2. Check API Key
    if (apiKey && ADMIN_API_KEY && apiKey === ADMIN_API_KEY) {
      req.user = { id: 'admin_apikey_user', role: 'admin' };
      next();
      return;
    }

    // 3. Check Bearer token
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        const verified = verifyToken(token);
        if (verified) {
          req.user = verified;
        }
        next();
        return;
      }
    }

    // 4. Dev demo fallback ONLY if explicitly enabled
    if (isDevDemoAuthEnabled() && !authHeader && !apiKey && !sessionToken) {
      req.user = DEFAULT_DEV_USER;
    }
  } catch {
    // Continue unauthenticated on unexpected error
  }

  next();
}

/**
 * Middleware enforcing authentication. Rejects with 401 if unauthenticated.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required. Please sign in with Google.' });
    return;
  }
  next();
}

/**
 * Middleware enforcing Single-Owner access.
 * Returns 401 if unauthenticated, 403 if authenticated identity lacks owner privileges.
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required. Please sign in with Google.' });
    return;
  }

  const isAuthorized = req.user.role === 'owner' || req.user.role === 'admin' || req.user.role === 'reviewer';
  if (!isAuthorized) {
    res.status(403).json({ error: 'Forbidden: Owner privileges required.' });
    return;
  }

  next();
}

/**
 * Middleware enforcing specific user role(s). Rejects with 403 if unauthorized.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: `Forbidden: requires one of roles [${allowedRoles.join(', ')}]` });
      return;
    }
    next();
  };
}

/**
 * Authorizes access to a pending import based on ownership.
 * Owner or administrative roles can access all imports.
 * Legacy unassigned imports or imports matching user id are also accessible.
 */
export function isAuthorizedForPendingImport(
  user: AuthUser,
  pendingImport: { userId?: string | null }
): boolean {
  if (user.role === 'owner' || user.role === 'admin' || user.role === 'reviewer') return true;
  if (!pendingImport.userId) return true;
  if (pendingImport.userId === user.id) return true;
  return false;
}
