import express, { Request, Response } from 'express';
import crypto from 'crypto';

// Mock Prisma
const mockSessions: any[] = [];
jest.mock('../lib/prisma', () => {
  const mockPrisma = {
    session: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const session = { id: `sess_${Date.now()}`, ...data };
        mockSessions.push(session);
        return session;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        return mockSessions.find((s) => s.sessionToken === where.sessionToken) || null;
      }),
      delete: jest.fn().mockImplementation(async ({ where }: any) => {
        const idx = mockSessions.findIndex((s) => s.id === where.id);
        if (idx !== -1) mockSessions.splice(idx, 1);
        return {};
      }),
      deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
        const initialLen = mockSessions.length;
        const remaining = mockSessions.filter((s) => s.sessionToken !== where.sessionToken);
        mockSessions.length = 0;
        mockSessions.push(...remaining);
        return { count: initialLen - remaining.length };
      }),
    },
    lead: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    import: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  return {
    __esModule: true,
    default: mockPrisma,
    prisma: mockPrisma,
  };
});

// Mock OAuth2Client
const mockGetToken = jest.fn();
const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => {
  return {
    OAuth2Client: jest.fn().mockImplementation(() => ({
      getToken: mockGetToken,
      verifyIdToken: mockVerifyIdToken,
    })),
  };
});

import authRouter, { oauthStateMap, STATE_TTL_MS } from '../routes/auth.route';
import leadsRouter from '../routes/leads.route';
import { authenticate, verifyCsrf, requireOwner } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';

// Helper to simulate express request through router
function invokeApp(
  handler: (req: Request, res: Response, next: any) => any,
  reqOptions: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: any;
  }
): Promise<{ statusCode: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve) => {
    const resHeaders: Record<string, string> = {};
    let statusCode = 200;
    let responseBody: any = null;

    const res: any = {
      statusCode: 200,
      setHeader: (name: string, value: string) => {
        resHeaders[name.toLowerCase()] = value;
      },
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (data: any) => {
        responseBody = data;
        resolve({ statusCode, headers: resHeaders, body: responseBody });
      },
      redirect: (url: string) => {
        statusCode = 302;
        resHeaders['location'] = url;
        resolve({ statusCode, headers: resHeaders, body: null });
      },
    };

    const req: any = {
      method: reqOptions.method,
      url: reqOptions.url,
      path: reqOptions.url.split('?')[0],
      headers: reqOptions.headers || {},
      query: reqOptions.query || {},
      body: reqOptions.body || {},
    };

    handler(req, res, () => {
      resolve({ statusCode, headers: resHeaders, body: responseBody });
    });
  });
}

describe('Google Authentication & Session Management', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSessions.length = 0;
    oauthStateMap.clear();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      APP_ORIGIN: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
      OWNER_GOOGLE_EMAIL: 'owner@example.com',
      OWNER_GOOGLE_SUB: 'google-sub-12345',
      SESSION_SECRET: 'test-secret-at-least-32-characters-long',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('GET /api/auth/google (Initiation)', () => {
    it('redirects to Google OAuth with valid state, nonce, and scopes', async () => {
      const app = express();
      app.use('/api/auth', authRouter);

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBeDefined();

      const redirectUrl = new URL(res.headers['location']);
      expect(redirectUrl.origin).toBe('https://accounts.google.com');
      expect(redirectUrl.pathname).toBe('/o/oauth2/v2/auth');
      expect(redirectUrl.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
      expect(redirectUrl.searchParams.get('scope')).toBe('openid email profile');
      expect(redirectUrl.searchParams.get('response_type')).toBe('code');

      const state = redirectUrl.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(oauthStateMap.has(state!)).toBe(true);
    });
  });

  describe('GET /api/auth/google/callback', () => {
    it('redirects with error if user denied consent', async () => {
      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google/callback',
        query: { error: 'access_denied' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:3000/?auth_error=denied');
    });

    it('rejects callback with invalid or missing state', async () => {
      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google/callback',
        query: { code: 'some-code', state: 'unknown-state' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:3000/?auth_error=invalid_state');
    });

    it('rejects callback with expired state', async () => {
      const state = 'expired-state-token';
      oauthStateMap.set(state, {
        nonce: 'test-nonce',
        createdAt: Date.now() - STATE_TTL_MS - 1000,
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google/callback',
        query: { code: 'some-code', state },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:3000/?auth_error=expired_state');
      expect(oauthStateMap.has(state)).toBe(false);
    });

    it('rejects callback if email is not verified', async () => {
      const state = 'valid-state';
      oauthStateMap.set(state, { nonce: 'test-nonce', createdAt: Date.now() });

      mockGetToken.mockResolvedValue({
        tokens: { id_token: 'fake-id-token' },
      });

      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          sub: 'google-sub-12345',
          email: 'owner@example.com',
          email_verified: false,
          nonce: 'test-nonce',
        }),
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google/callback',
        query: { code: 'valid-code', state },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:3000/?auth_error=email_not_verified');
      expect(mockSessions.length).toBe(0);
    });

    it('rejects callback if nonce does not match', async () => {
      const state = 'valid-state';
      oauthStateMap.set(state, { nonce: 'correct-nonce', createdAt: Date.now() });

      mockGetToken.mockResolvedValue({
        tokens: { id_token: 'fake-id-token' },
      });

      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          sub: 'google-sub-12345',
          email: 'owner@example.com',
          email_verified: true,
          nonce: 'wrong-nonce',
        }),
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google/callback',
        query: { code: 'valid-code', state },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:3000/?auth_error=invalid_nonce');
      expect(mockSessions.length).toBe(0);
    });

    it('rejects unauthorized Google accounts and creates NO session', async () => {
      const state = 'valid-state';
      oauthStateMap.set(state, { nonce: 'test-nonce', createdAt: Date.now() });

      mockGetToken.mockResolvedValue({
        tokens: { id_token: 'fake-id-token' },
      });

      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          sub: 'some-other-sub',
          email: 'stranger@example.com', // Not owner@example.com
          email_verified: true,
          nonce: 'test-nonce',
          name: 'Stranger Danger',
        }),
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google/callback',
        query: { code: 'valid-code', state },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:3000/?auth_error=unauthorized');
      expect(mockSessions.length).toBe(0); // Zero sessions created!
    });

    it('rejects authorized email if OWNER_GOOGLE_SUB does not match', async () => {
      const state = 'valid-state';
      oauthStateMap.set(state, { nonce: 'test-nonce', createdAt: Date.now() });

      mockGetToken.mockResolvedValue({
        tokens: { id_token: 'fake-id-token' },
      });

      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          sub: 'different-google-sub',
          email: 'owner@example.com',
          email_verified: true,
          nonce: 'test-nonce',
        }),
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google/callback',
        query: { code: 'valid-code', state },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:3000/?auth_error=unauthorized');
      expect(mockSessions.length).toBe(0);
    });

    it('successfully establishes owner session for configured owner', async () => {
      const state = 'valid-state';
      oauthStateMap.set(state, { nonce: 'test-nonce', createdAt: Date.now() });

      mockGetToken.mockResolvedValue({
        tokens: { id_token: 'fake-id-token' },
      });

      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          sub: 'google-sub-12345',
          email: 'owner@example.com',
          email_verified: true,
          nonce: 'test-nonce',
          name: 'LeadSync Owner',
          picture: 'https://lh3.googleusercontent.com/avatar.jpg',
        }),
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/google/callback',
        query: { code: 'valid-code', state },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('http://localhost:3000/');
      expect(res.headers['set-cookie']).toBeDefined();
      expect(res.headers['set-cookie']).toContain('leadsync_session=');
      expect(res.headers['set-cookie']).toContain('HttpOnly');
      expect(res.headers['set-cookie']).toContain('SameSite=Lax');

      expect(mockSessions.length).toBe(1);
      expect(mockSessions[0].email).toBe('owner@example.com');
      expect(mockSessions[0].googleSub).toBe('google-sub-12345');
      expect(mockSessions[0].name).toBe('LeadSync Owner');
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns { authenticated: false } when no session cookie is provided', async () => {
      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/me',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ authenticated: false });
    });

    it('returns { authenticated: false } for expired session', async () => {
      mockSessions.push({
        id: 'sess_1',
        sessionToken: 'expired-token',
        googleSub: 'google-sub-12345',
        email: 'owner@example.com',
        expiresAt: new Date(Date.now() - 1000), // Expired
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/me',
        headers: { cookie: 'leadsync_session=expired-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ authenticated: false });
    });

    it('returns authenticated owner info for valid session', async () => {
      mockSessions.push({
        id: 'sess_1',
        sessionToken: 'valid-token',
        googleSub: 'google-sub-12345',
        email: 'owner@example.com',
        name: 'LeadSync Owner',
        picture: 'https://lh3.googleusercontent.com/avatar.jpg',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'GET',
        url: '/me',
        headers: { cookie: 'leadsync_session=valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        authenticated: true,
        user: {
          email: 'owner@example.com',
          name: 'LeadSync Owner',
          picture: 'https://lh3.googleusercontent.com/avatar.jpg',
        },
      });
    });
  });

  describe('POST /api/auth/logout', () => {
    it('invalidates the session in DB and clears session cookie', async () => {
      mockSessions.push({
        id: 'sess_1',
        sessionToken: 'token-to-logout',
        googleSub: 'google-sub-12345',
        email: 'owner@example.com',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const res = await invokeApp((req, res) => authRouter(req, res, () => {}), {
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'leadsync_session=token-to-logout' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockSessions.length).toBe(0);
      expect(res.headers['set-cookie']).toContain('Max-Age=0');
    });
  });

  describe('Authorization & Public Protection', () => {
    it('rejects unauthenticated request to GET /api/leads with 401', async () => {
      const runner = async (req: Request, res: Response) => {
        await authenticate(req, res, () => {
          leadsRouter(req, res, () => {});
        });
      };

      const res = await invokeApp(runner, {
        method: 'GET',
        url: '/',
      });

      expect(res.statusCode).toBe(401);
      expect(res.body.error).toMatch(/Authentication required/i);
    });

    it('rejects state-changing request from unauthorized cross-site origin with 403 (CSRF)', async () => {
      const runner = async (req: Request, res: Response) => {
        verifyCsrf(req, res, () => {
          res.json({ success: true });
        });
      };

      const res = await invokeApp(runner, {
        method: 'POST',
        url: '/api/leads/delete',
        headers: { origin: 'https://evil-attacker.com' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toMatch(/CSRF verification failed/i);
    });

    it('permits authorized owner session to access protected endpoints', async () => {
      mockSessions.push({
        id: 'sess_owner',
        sessionToken: 'owner-session-token',
        googleSub: 'google-sub-12345',
        email: 'owner@example.com',
        expiresAt: new Date(Date.now() + 86400000),
      });

      const runner = async (req: Request, res: Response) => {
        await authenticate(req, res, () => {
          leadsRouter(req, res, () => {});
        });
      };

      const res = await invokeApp(runner, {
        method: 'GET',
        url: '/',
        headers: { cookie: 'leadsync_session=owner-session-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('leads');
    });
  });
});
