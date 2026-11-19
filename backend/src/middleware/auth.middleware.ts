import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';

export type UserRole = 'owner';

export interface AuthUser {
  id: string;
  role: UserRole;
  email: string;
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
 * Session verification middleware.
 * Verifies session strictly via the leadsync_session HttpOnly cookie against the database.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies['leadsync_session'];

    if (sessionToken) {
      try {
        const session = await prisma.session.findUnique({
          where: { sessionToken },
        });

        if (session && new Date() <= session.expiresAt) {
          const ownerEmail = process.env.OWNER_GOOGLE_EMAIL?.trim();
          // Strictly fail closed if OWNER_GOOGLE_EMAIL is not configured
          if (!ownerEmail) {
            return next();
          }

          const emailMatches = session.email.toLowerCase() === ownerEmail.toLowerCase();
          const ownerSub = process.env.OWNER_GOOGLE_SUB?.trim();
          const subMatches = !ownerSub || session.googleSub === ownerSub;

          if (emailMatches && subMatches) {
            req.user = {
              id: session.googleSub,
              role: 'owner',
              email: session.email,
              name: session.name,
              picture: session.picture,
            };
            return next();
          }
        }
      } catch {
        // If DB query fails, continue unauthenticated
      }
    }
  } catch {
    // Continue unauthenticated on unexpected error
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

  if (req.user.role !== 'owner') {
    res.status(403).json({ error: 'Forbidden: Owner privileges required.' });
    return;
  }

  next();
}

/**
 * Alias for requireOwner to protect all CRM endpoints with single-owner authorization.
 */
export const requireAuth = requireOwner;

/**
 * Authorizes access to a pending import based on ownership.
 */
export function isAuthorizedForPendingImport(
  user: AuthUser,
  pendingImport: { userId?: string | null }
): boolean {
  if (pendingImport.userId && pendingImport.userId !== user.id) {
    return false;
  }
  return true;
}
