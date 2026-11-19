/**
 * End-to-End Integration Test:
 * CSV Headers -> Gemini Function Request -> Backend Tool Execution ->
 * Function Response -> Final Mapping Plan -> CRM Record Batch Extraction ->
 * Staged PendingImport -> Human Review -> Explicit Owner Approval -> DB Persistence.
 *
 * Verifies actual native function calling message exchanges and the complete
 * human-in-the-loop pipeline.
 */

process.env.GEMINI_API_KEY = 'test-integration-key';
process.env.GEMINI_MODEL = 'gemini-2.5-flash';

import express from 'express';
import { GoogleGenAI } from '@google/genai';

// Mock Prisma
const mockPendingImports = new Map<string, any>();
const mockCommittedImports = new Map<string, any>();
const mockCommittedLeads: any[] = [];

jest.mock('../lib/prisma', () => {
  const mockPrisma = {
    session: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.sessionToken === 'valid_owner_session') {
          return {
            id: 'sess_owner',
            sessionToken: 'valid_owner_session',
            googleSub: 'google_user_owner',
            email: 'owner@leadsync.com',
            name: 'LeadSync Owner',
            picture: null,
            expiresAt: new Date(Date.now() + 86400000),
          };
        }
        return null;
      }),
    },
    pendingImport: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = `pending_${Date.now()}`;
        const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        mockPendingImports.set(id, record);
        return record;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        return mockPendingImports.get(where.id) || null;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const existing = mockPendingImports.get(where.id);
        if (!existing) throw new Error('Not found');
        const updated = { ...existing, ...data, updatedAt: new Date() };
        mockPendingImports.set(where.id, updated);
        return updated;
      }),
      updateMany: jest.fn().mockImplementation(async () => ({ count: 1 })),
    },
    import: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = `import_${Date.now()}`;
        const rec = { id, ...data, createdAt: new Date() };
        mockCommittedImports.set(id, rec);
        return rec;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        return mockCommittedImports.get(where.id) || null;
      }),
    },
    lead: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const rec = { id: `lead_${Date.now()}_${Math.random()}`, ...data, importedAt: new Date() };
        mockCommittedLeads.push(rec);
        return rec;
      }),
    },
    skippedRow: {
      create: jest.fn(),
    },
    $transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => {
      const tx = {
        pendingImport: {
          findUnique: async ({ where }: any) => mockPendingImports.get(where.id) || null,
          update: async ({ where, data }: any) => {
            const existing = mockPendingImports.get(where.id);
            const updated = { ...existing, ...data };
            mockPendingImports.set(where.id, updated);
            return updated;
          },
          updateMany: async ({ where, data }: any) => {
            const existing = mockPendingImports.get(where.id);
            if (existing) {
              const updated = { ...existing, ...data };
              mockPendingImports.set(where.id, updated);
              return { count: 1 };
            }
            return { count: 0 };
          },
        },
        import: {
          create: async ({ data }: any) => {
            const id = `import_${Date.now()}`;
            const rec = { id, ...data, createdAt: new Date() };
            mockCommittedImports.set(id, rec);
            if (data.leads?.create) {
              mockCommittedLeads.push(...data.leads.create);
            }
            return rec;
          },
        },
        lead: {
          create: async ({ data }: any) => {
            const rec = { id: `lead_${Date.now()}_${Math.random()}`, ...data };
            mockCommittedLeads.push(rec);
            return rec;
          },
        },
        skippedRow: {
          create: async () => {},
        },
      };
      return cb(tx);
    }),
  };

  return {
    __esModule: true,
    default: mockPrisma,
    prisma: mockPrisma,
  };
});

// Mock GoogleGenAI
jest.mock('@google/genai');
const MockedGoogleGenAI = GoogleGenAI as jest.MockedClass<typeof GoogleGenAI>;

import extractRouter from '../routes/extract.route';
import importsRouter from '../routes/imports.route';
import { authenticate } from '../middleware/auth.middleware';
import prisma from '../lib/prisma';

function invokeRouter(
  router: express.Router,
  reqOptions: {
    method: string;
    url: string;
    body?: any;
    file?: any;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; headers: Record<string, string>; body: any; rawEvents: string[] }> {
  return new Promise((resolve) => {
    const rawEvents: string[] = [];
    const responseHeaders: Record<string, string> = {};
    let statusCode = 200;
    let responseBody: any = '';

    const req: any = {
      method: reqOptions.method,
      url: reqOptions.url,
      baseUrl: '',
      originalUrl: reqOptions.url,
      path: reqOptions.url.split('?')[0],
      params: {},
      query: {},
      body: reqOptions.body || {},
      file: reqOptions.file,
      headers: {
        host: 'localhost:4000',
        origin: 'http://localhost:3000',
        ...reqOptions.headers,
      },
      get: (h: string) => {
        const lower = h.toLowerCase();
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() === lower) return v;
        }
        return undefined;
      },
    };

    const qIdx = reqOptions.url.indexOf('?');
    if (qIdx !== -1) {
      const qStr = reqOptions.url.substring(qIdx + 1);
      qStr.split('&').forEach((pair) => {
        const [k, v] = pair.split('=');
        if (k) req.query[k] = decodeURIComponent(v || '');
      });
    }

    const res: any = {
      writable: true,
      writableEnded: false,
      setHeader: (k: string, v: string) => {
        responseHeaders[k.toLowerCase()] = v;
      },
      getHeader: (k: string) => responseHeaders[k.toLowerCase()],
      flushHeaders: () => {},
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      write: (chunk: string) => {
        rawEvents.push(chunk);
        return true;
      },
      json: (data: any) => {
        responseBody = data;
        res.writableEnded = true;
        resolve({ status: statusCode, headers: responseHeaders, body: responseBody, rawEvents });
      },
      send: (data: any) => {
        responseBody = data;
        res.writableEnded = true;
        resolve({ status: statusCode, headers: responseHeaders, body: responseBody, rawEvents });
      },
      end: (data?: any) => {
        if (data) responseBody = data;
        res.writableEnded = true;
        resolve({ status: statusCode, headers: responseHeaders, body: responseBody, rawEvents });
      },
    };

    authenticate(req, res, () => {
      router(req, res, (err: any) => {
        if (err) {
          resolve({ status: 500, headers: responseHeaders, body: { error: err.message }, rawEvents });
        } else {
          resolve({ status: statusCode, headers: responseHeaders, body: responseBody, rawEvents });
        }
      });
    });
  });
}

describe('End-to-End Tool Orchestration & Approval Integration Test', () => {
  let mockSendMessage: jest.Mock;
  let mockGenerateContent: jest.Mock;

  beforeEach(() => {
    mockPendingImports.clear();
    mockCommittedImports.clear();
    mockCommittedLeads.length = 0;
    jest.clearAllMocks();
    process.env.OWNER_GOOGLE_EMAIL = 'owner@leadsync.com';

    mockSendMessage = jest.fn();
    mockGenerateContent = jest.fn();

    MockedGoogleGenAI.mockImplementation(
      () =>
        ({
          chats: {
            create: jest.fn(() => ({
              sendMessage: mockSendMessage,
            })),
          },
          models: {
            generateContent: mockGenerateContent,
          },
        }) as unknown as GoogleGenAI
    );
  });

  it('completes the full tool-orchestrated pipeline from CSV upload to atomic CRM persistence', async () => {
    // -------------------------------------------------------------------------
    // Step 1: Mock Gemini Multi-Turn Function Calling Conversation
    // -------------------------------------------------------------------------

    // Turn 1: Model requests get_crm_schema and retrieve_mapping_examples
    mockSendMessage.mockResolvedValueOnce({
      response: {
        functionCalls: () => [
          { name: 'get_crm_schema', args: {} },
          { name: 'retrieve_mapping_examples', args: { headers: ['Cust_Name', 'Mob_No', 'Emal'] } },
        ],
        text: () => '',
      },
    });

    // Turn 2: Model receives tool outputs, requests validate_mapping
    mockSendMessage.mockResolvedValueOnce({
      response: {
        functionCalls: () => [
          {
            name: 'validate_mapping',
            args: {
              mappings: [
                { source: 'Cust_Name', target: 'name' },
                { source: 'Mob_No', target: 'mobile_without_country_code' },
                { source: 'Emal', target: 'email' },
                { source: 'City', target: 'city' },
              ],
            },
          },
        ],
        text: () => '',
      },
    });

    // Turn 3: Model receives validation result and returns the final mapping plan
    mockSendMessage.mockResolvedValueOnce({
      response: {
        functionCalls: () => undefined,
        text: () =>
          JSON.stringify({
            mappings: [
              { source: 'Cust_Name', target: 'name', reasoning: 'Lead contact name' },
              { source: 'Mob_No', target: 'mobile_without_country_code', reasoning: 'Mobile phone' },
              { source: 'Emal', target: 'email', reasoning: 'Primary email' },
              { source: 'City', target: 'city', reasoning: 'Lead location city' },
            ],
          }),
      },
    });

    // -------------------------------------------------------------------------
    // Step 2: Mock Stage B Batch Record Extraction
    // -------------------------------------------------------------------------
    const extractedCRMRows = [
      {
        created_at: '2026-05-13T00:00:00.000Z',
        name: 'Rahul Sharma',
        email: 'rahul.sharma@example.com',
        country_code: '+91',
        mobile_without_country_code: '9876543210',
        company: null,
        city: 'Bangalore',
        state: null,
        country: null,
        lead_owner: null,
        crm_status: 'GOOD_LEAD_FOLLOW_UP',
        crm_note: null,
        data_source: null,
        possession_time: null,
        description: null,
        skip: false,
        skipReason: null,
      },
    ];

    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify(extractedCRMRows),
      },
    });

    // -------------------------------------------------------------------------
    // Step 3: Upload CSV to /api/extract
    // -------------------------------------------------------------------------
    const csvContent = 'Cust_Name,Mob_No,Emal,City\nRahul Sharma,+91 9876543210,rahul.sharma@example.com,Bangalore';
    const csvBuffer = Buffer.from(csvContent, 'utf-8');

    const extractRes = await invokeRouter(extractRouter, {
      method: 'POST',
      url: '/',
      file: {
        originalname: 'leads_export.csv',
        mimetype: 'text/csv',
        buffer: csvBuffer,
        size: csvBuffer.length,
      },
      headers: {
        cookie: 'leadsync_session=valid_owner_session',
      },
    });

    // Verify SSE headers
    expect(extractRes.headers['content-type']).toBe('text/event-stream');

    // Verify Gemini tool orchestration occurred
    expect(mockSendMessage).toHaveBeenCalledTimes(3);

    // Verify turn 1 executed get_crm_schema and retrieve_mapping_examples
    const turn2Param = mockSendMessage.mock.calls[1][0];
    const turn2Input = turn2Param.message ?? turn2Param;
    expect(turn2Input).toHaveLength(2);
    expect(turn2Input[0].functionResponse.name).toBe('get_crm_schema');
    expect(turn2Input[1].functionResponse.name).toBe('retrieve_mapping_examples');

    // Verify turn 2 executed validate_mapping
    const turn3Param = mockSendMessage.mock.calls[2][0];
    const turn3Input = turn3Param.message ?? turn3Param;
    expect(turn3Input).toHaveLength(1);
    expect(turn3Input[0].functionResponse.name).toBe('validate_mapping');
    expect(turn3Input[0].functionResponse.response.valid).toBe(true);

    // Verify Stage B extraction was called with validated mappings
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const callArg = mockGenerateContent.mock.calls[0][0];
    const extractionPrompt = typeof callArg === 'string' ? callArg : (callArg.contents ?? '');
    expect(extractionPrompt).toContain('VALIDATED COLUMN MAPPINGS');
    expect(extractionPrompt).toContain('Cust_Name');

    // Verify PendingImport was staged and no leads committed yet
    expect(mockPendingImports.size).toBe(1);
    const pendingImport = Array.from(mockPendingImports.values())[0];
    expect(pendingImport.status).toBe('PENDING');
    expect(pendingImport.records).toHaveLength(1);

    // Strict security check: Leads table MUST have 0 records prior to explicit human approval
    expect(mockCommittedLeads).toHaveLength(0);
    expect(mockCommittedImports.size).toBe(0);

    // Parse SSE complete event
    const completeEventStr = extractRes.rawEvents.find((e) => e.includes('"type":"complete"'));
    expect(completeEventStr).toBeDefined();
    const completeData = JSON.parse(completeEventStr!.replace('data: ', '').trim());
    expect(completeData.pendingImportId).toBe(pendingImport.id);
    expect(completeData.totalValid).toBe(1);
    expect(completeData.totalImported).toBe(0);

    // -------------------------------------------------------------------------
    // Step 4: Human Review & Explicit Owner Approval (POST /api/imports/:id/approve)
    // -------------------------------------------------------------------------
    const approveRes = await invokeRouter(importsRouter, {
      method: 'POST',
      url: `/${pendingImport.id}/approve`,
      headers: {
        cookie: 'leadsync_session=valid_owner_session',
      },
    });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.totalImported).toBe(1);
    expect(approveRes.body.importId).toBeDefined();

    // Verify atomic database persistence succeeded
    expect(mockCommittedImports.size).toBe(1);
    expect(mockCommittedLeads).toHaveLength(1);
    expect(mockCommittedLeads[0].name).toBe('Rahul Sharma');
    expect(mockCommittedLeads[0].email).toBe('rahul.sharma@example.com');
    expect(mockCommittedLeads[0].mobileWithoutCountryCode).toBe('9876543210');
    expect(mockCommittedLeads[0].city).toBe('Bangalore');

    // Verify PendingImport status updated to APPROVED with committedImportId
    const committedPending = mockPendingImports.get(pendingImport.id);
    expect(committedPending.status).toBe('APPROVED');
    expect(committedPending.committedImportId).toBe(approveRes.body.importId);
  });
});
