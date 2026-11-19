import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export type UserRole = 'admin' | 'reviewer' | 'user';

export interface AuthUser {
  id: string;
  role: UserRole;
  email?: string;
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
 * Returns the authentication secret for token signing and verification.
 * Fails safely in production if neither AUTH_SECRET nor JWT_SECRET is configured.
 */
export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.JWT_SECRET;
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
 * Never allowed in production mode.
 */
export function isDevDemoAuthEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    (process.env.ALLOW_DEV_ANONYMOUS === 'true' || process.env.ENABLE_DEV_DEMO_AUTH === 'true')
  );
}

// Deterministic fallback dev user for explicitly enabled local DX demo mode
export const DEFAULT_DEV_USER: AuthUser = {
  id: 'usr_dev_reviewer_01',
  role: 'reviewer',
  email: 'reviewer@leadsync.internal',
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
 * Middleware that extracts credentials from Authorization: Bearer or x-api-key header.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] as string | undefined;

  // 1. Check API Key
  if (apiKey && ADMIN_API_KEY && apiKey === ADMIN_API_KEY) {
    req.user = { id: 'admin_apikey_user', role: 'admin' };
    next();
    return;
  }

  // 2. Check Bearer token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      const verified = verifyToken(token);
      if (verified) {
        req.user = verified;
      }
      // If a Bearer token was provided, it must be genuinely valid.
      // Do not fall back to dev demo user if an invalid/placeholder token was provided.
      next();
      return;
    }
  }

  // 3. Allow anonymous dev fallback ONLY if explicitly opted in via isDevDemoAuthEnabled()
  // and no credentials were supplied. Never allowed in production.
  if (isDevDemoAuthEnabled() && !authHeader && !apiKey) {
    req.user = DEFAULT_DEV_USER;
  }

  next();
}

/**
 * Middleware enforcing authentication. Rejects with 401 if not authenticated.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required. Please provide a valid Bearer token or API key.' });
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
 * Authorizes access to a pending import based on ownership and role.
 * Admins can access all imports.
 * Reviewers can access unassigned imports or imports assigned to them.
 * Users can only access imports they created.
 */
export function isAuthorizedForPendingImport(
  user: AuthUser,
  pendingImport: { userId?: string | null }
): boolean {
  if (user.role === 'admin') return true;
  if (!pendingImport.userId) return true; // Legacy or unassigned
  if (pendingImport.userId === user.id) return true;
  if (user.role === 'reviewer') return true; // Reviewers are authorized to review imports
  return false;
}
