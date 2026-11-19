/**
 * Tests for the Human-in-the-Loop Extraction and Approval Workflow.
 *
 * Verifies:
 * 1. Extraction does not create records in the final leads/import tables.
 * 2. Valid extraction creates a pending import in temporary storage.
 * 3. Database persistence failures during extraction do not falsely report success.
 * 4. Approval persists previously validated pending records into Import and Lead tables.
 * 5. Rejection results in zero persisted CRM leads and marks status as REJECTED.
 * 6. Repeated rejection requests are handled gracefully.
 * 7. Invalid pending data cannot be committed (fails server-side schema revalidation).
 * 8. Repeated approval does not create duplicate imports (idempotency).
 * 9. Concurrent approval attempts cannot create duplicate records.
 * 10. Database failures during approval do not falsely mark an import successful.
 * 11. Expired or rejected imports cannot be approved.
 */

import express from 'express';

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
        if (where.sessionToken === 'owner_session_token') {
          return {
            id: 'sess_default_owner',
            sessionToken: 'owner_session_token',
            googleSub: 'test_user_1',
            email: 'owner@example.com',
            name: 'Test Owner',
            picture: null,
            expiresAt: new Date(Date.now() + 86400000),
          };
        }
        return mockSessions.find((s) => s.sessionToken === where.sessionToken) || null;
      }),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    pendingImport: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    import: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    lead: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    skippedRow: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  return {
    __esModule: true,
    default: mockPrisma,
    prisma: mockPrisma,
  };
});

// Mock AI orchestrator
jest.mock('../services/importOrchestrator.service', () => ({
  orchestrateImport: jest.fn(),
}));

import prisma from '../lib/prisma';
import { orchestrateImport } from '../services/importOrchestrator.service';
import extractRouter from '../routes/extract.route';
import importsRouter from '../routes/imports.route';
import { authenticate } from '../middleware/auth.middleware';
import type { CRMRecord, SkippedRow } from '../types';

const mockPrisma = prisma as unknown as {
  pendingImport: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  import: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  lead: {
    create: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
};

const mockOrchestrateImport = orchestrateImport as jest.MockedFunction<typeof orchestrateImport>;

/**
 * In-memory router invoker to avoid TCP socket EACCES restrictions in sandboxed test environments.
 */
function invokeRouter(
  router: express.Router,
  reqOptions: {
    method: string;
    url: string;
    body?: any;
    file?: any;
    headers?: Record<string, string>;
    user?: any;
  }
): Promise<{ statusCode: number; body: any; rawWrites: string[] }> {
  return new Promise((resolve, reject) => {
    const rawWrites: string[] = [];
    let resolved = false;

    const req: any = {
      method: reqOptions.method,
      url: reqOptions.url,
      originalUrl: reqOptions.url,
      baseUrl: '',
      params: {},
      query: {},
      body: reqOptions.body || {},
      file: reqOptions.file,
      headers:
        reqOptions.headers !== undefined
          ? reqOptions.headers
          : { cookie: 'leadsync_session=owner_session_token' },
      user: reqOptions.user,
      on: jest.fn(),
    };

    const finish = (statusCode: number, body: any) => {
      if (resolved) return;
      resolved = true;
      resolve({ statusCode, body, rawWrites });
    };

    const listeners: Record<string, Function[]> = {};
    const res: any = {
      statusCode: 200,
      headers: {},
      writable: true,
      writableEnded: false,
      on(event: string, listener: Function) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(listener);
        return this;
      },
      emit(event: string, ...args: any[]) {
        (listeners[event] || []).forEach((fn) => fn(...args));
        return true;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        finish(this.statusCode, data);
        return this;
      },
      send(data: any) {
        finish(this.statusCode, data);
        return this;
      },
      setHeader(name: string, value: string) {
        this.headers[name] = value;
        return this;
      },
      flushHeaders: jest.fn(),
      write(chunk: any) {
        if (!this.writableEnded) {
          rawWrites.push(chunk ? chunk.toString() : '');
        }
        return true;
      },
      end() {
        this.writableEnded = true;
        this.emit('finish');
        this.emit('close');
        if (!resolved) {
          finish(this.statusCode, rawWrites.join(''));
        }
      },
    };

    authenticate(req, res, () => {
      router(req, res, (err: any) => {
        if (err) reject(err);
        else finish(res.statusCode, null);
      });
    });
  });
}

const initialEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...initialEnv };
  process.env.NODE_ENV = 'test';
  delete process.env.ALLOW_DEV_ANONYMOUS;
  delete process.env.ENABLE_DEV_DEMO_AUTH;
});

afterAll(() => {
  process.env = initialEnv;
});

const sampleValidRecord: CRMRecord = {
  created_at: '2024-05-13T00:00:00.000Z',
  name: 'Rahul Sharma',
  email: 'rahul@example.com',
  country_code: '+91',
  mobile_without_country_code: '9876543210',
  company: 'Tech Corp',
  city: 'Bangalore',
  state: 'Karnataka',
  country: 'India',
  lead_owner: 'Priya',
  crm_status: 'GOOD_LEAD_FOLLOW_UP',
  crm_note: null,
  data_source: 'eden_park',
  possession_time: 'Ready to move',
  description: null,
};

const sampleSkippedRow: SkippedRow = {
  row: { Name: 'Unknown Contact' },
  reason: 'No email or mobile number found',
};

// ============================================================================
// Phase A: Extraction & Staging (No direct CRM persistence)
// ============================================================================
describe('Phase A: Extract and prepare', () => {
  it('does NOT create records in final leads or imports tables, but creates a PendingImport', async () => {
    const csvContent = 'Name,Email,Phone\nRahul Sharma,rahul@example.com,9876543210\n';

    mockOrchestrateImport.mockImplementation(async (_rows, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 1,
        batchRecords: [sampleValidRecord],
        batchSkipped: [],
        batchFailed: [],
      });
      return {
        records: [sampleValidRecord],
        skipped: [],
        failed: [],
      };
    });

    mockPrisma.pendingImport.create.mockResolvedValue({
      id: 'pending_123',
      filename: 'leads.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
    });

    const { statusCode, rawWrites } = await invokeRouter(extractRouter, {
      method: 'POST',
      url: '/',
      file: {
        originalname: 'leads.csv',
        buffer: Buffer.from(csvContent),
        mimetype: 'text/csv',
      },
    });

    expect(statusCode).toBe(200);

    const bodyText = rawWrites.join('');
    expect(bodyText).toContain('"type":"complete"');
    expect(bodyText).toContain('"pendingImportId":"pending_123"');
    expect(bodyText).toContain('"totalImported":0'); // Crucial: 0 leads persisted to final CRM!

    // Verify final CRM tables were NOT touched
    expect(mockPrisma.import.create).not.toHaveBeenCalled();
    expect(mockPrisma.lead.create).not.toHaveBeenCalled();

    // Verify PendingImport was created
    expect(mockPrisma.pendingImport.create).toHaveBeenCalledTimes(1);
    const createCall = mockPrisma.pendingImport.create.mock.calls[0][0];
    expect(createCall.data.status).toBe('PENDING');
    expect(createCall.data.filename).toBe('leads.csv');
    expect(createCall.data.records).toHaveLength(1);
    expect(createCall.data.expiresAt).toBeInstanceOf(Date);
  });

  it('handles database staging failure by sending an error SSE event without claiming success', async () => {
    const csvContent = 'Name,Email\nTest,test@example.com\n';

    mockOrchestrateImport.mockResolvedValue({
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
    });

    mockPrisma.pendingImport.create.mockRejectedValue(new Error('Connection failure'));

    const { rawWrites } = await invokeRouter(extractRouter, {
      method: 'POST',
      url: '/',
      file: {
        originalname: 'test.csv',
        buffer: Buffer.from(csvContent),
        mimetype: 'text/csv',
      },
    });

    const bodyText = rawWrites.join('');
    expect(bodyText).toContain('"type":"error"');
    expect(bodyText).not.toContain('"type":"complete"');
    expect(mockPrisma.import.create).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Phase B: Human Approval and Commit
// ============================================================================
describe('Phase B: Human approval and commit', () => {
  it('persists previously validated pending records into Import and Lead tables upon approval', async () => {
    const pendingData = {
      id: 'pending_abc',
      filename: 'sample.csv',
      totalRows: 2,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [sampleSkippedRow],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(pendingData);

    // Mock transaction execution
    mockPrisma.$transaction.mockImplementation(async (callback) => {
      const txMock = {
        pendingImport: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue(pendingData),
          update: jest.fn().mockResolvedValue({ ...pendingData, status: 'COMMITTED', committedImportId: 'final_imp_1' }),
        },
        import: {
          create: jest.fn().mockResolvedValue({
            id: 'final_imp_1',
            filename: 'sample.csv',
            totalRows: 2,
            totalImported: 1,
            totalSkipped: 1,
          }),
        },
      };
      return callback(txMock);
    });

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_abc/approve',
    });

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.importId).toBe('final_imp_1');
    expect(body.totalImported).toBe(1);
    expect(body.totalSkipped).toBe(1);
  });

  it('rejects approval when the pending import is expired', async () => {
    const expiredPending = {
      id: 'pending_expired',
      filename: 'old.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() - 1000), // In the past!
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(expiredPending);
    mockPrisma.pendingImport.update.mockResolvedValue({ ...expiredPending, status: 'EXPIRED' });

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_expired/approve',
    });

    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/expired/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.import.create).not.toHaveBeenCalled();
  });

  it('rejects approval when the pending import was previously rejected', async () => {
    const rejectedPending = {
      id: 'pending_rejected',
      filename: 'rejected.csv',
      totalRows: 1,
      status: 'REJECTED',
      records: [],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(rejectedPending);

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_rejected/approve',
    });

    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/rejected and cannot be approved/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to commit invalid pending data (server-side revalidation failure)', async () => {
    const invalidPending = {
      id: 'pending_invalid',
      filename: 'tampered.csv',
      totalRows: 1,
      status: 'PENDING',
      // Record missing both email and phone number
      records: [
        {
          name: 'Invalid Guy',
          email: null,
          mobile_without_country_code: null,
        },
      ],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(invalidPending);

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_invalid/approve',
    });

    expect(statusCode).toBe(422);
    expect(body.error).toMatch(/Invalid pending data/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to commit staged records containing AI-only fields (skip / skipReason) or unexpected keys', async () => {
    const invalidPending = {
      id: 'pending_unexpected_fields',
      filename: 'sample.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [
        {
          ...sampleValidRecord,
          skip: false,
          skipReason: null,
        },
      ],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(invalidPending);

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_unexpected_fields/approve',
    });

    expect(statusCode).toBe(422);
    expect(body.error).toMatch(/Invalid pending data at record 1/i);
    expect(body.error).toMatch(/Unrecognized key/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('is idempotent: repeated approval returns existing committed import without creating duplicates', async () => {
    const alreadyCommitted = {
      id: 'pending_already_done',
      filename: 'sample.csv',
      totalRows: 1,
      status: 'COMMITTED',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: 'existing_import_999',
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(alreadyCommitted);

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_already_done/approve',
    });

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.importId).toBe('existing_import_999');
    expect(body.message).toMatch(/already approved/i);

    // Verify transaction or new import was NOT executed
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.import.create).not.toHaveBeenCalled();
  });

  it('prevents concurrent approval race conditions from creating duplicate records', async () => {
    const pendingRecord = {
      id: 'pending_concurrent',
      filename: 'concurrent.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(pendingRecord);

    // Simulate concurrent lock collision: updateMany returns count: 0
    mockPrisma.$transaction.mockImplementation(async (callback) => {
      const txMock = {
        pendingImport: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }), // Another request acquired lock!
          findUnique: jest.fn().mockResolvedValue({
            ...pendingRecord,
            status: 'COMMITTED',
            committedImportId: 'committed_by_concurrent_tx',
          }),
        },
        import: {
          create: jest.fn(),
        },
      };
      return callback(txMock);
    });

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_concurrent/approve',
    });

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.importId).toBe('committed_by_concurrent_tx');
  });

  it('handles database persistence failure cleanly without falsely marking success', async () => {
    const pendingData = {
      id: 'pending_db_fail',
      filename: 'fail.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(pendingData);

    mockPrisma.$transaction.mockImplementation(async () => {
      throw new Error('Database disk error');
    });

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_db_fail/approve',
    });

    expect(statusCode).toBe(500);
    expect(body.error).toMatch(/Failed to commit/i);
  });
});

// ============================================================================
// Phase C: Human Rejection
// ============================================================================
describe('Phase C: Human rejection', () => {
  it('updates pending import status to REJECTED, clears staged PII, and creates zero CRM leads', async () => {
    const pendingData = {
      id: 'pending_to_reject',
      filename: 'sample.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(pendingData);
    mockPrisma.pendingImport.updateMany.mockResolvedValue({ count: 1 });

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_to_reject/reject',
    });

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.status).toBe('REJECTED');

    // Verify zero final CRM leads or imports were created
    expect(mockPrisma.import.create).not.toHaveBeenCalled();
    expect(mockPrisma.lead.create).not.toHaveBeenCalled();

    // Verify staged records, skipped, and failed were all wiped atomically to purge PII
    expect(mockPrisma.pendingImport.updateMany).toHaveBeenCalledWith({
      where: { id: 'pending_to_reject', status: 'PENDING' },
      data: {
        status: 'REJECTED',
        records: [],
        skipped: [],
        failed: [],
      },
    });
  });

  it('handles repeated rejection requests gracefully', async () => {
    const alreadyRejected = {
      id: 'pending_already_rejected',
      filename: 'sample.csv',
      totalRows: 1,
      status: 'REJECTED',
      records: [],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(alreadyRejected);

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_already_rejected/reject',
    });

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/already rejected/i);
    expect(mockPrisma.pendingImport.update).not.toHaveBeenCalled();
  });

  it('cannot reject an import that was already committed', async () => {
    const committed = {
      id: 'pending_committed',
      filename: 'sample.csv',
      totalRows: 1,
      status: 'COMMITTED',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: 'imp_1',
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(committed);

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_committed/reject',
    });

    expect(statusCode).toBe(400);
    expect(body.error).toMatch(/Cannot reject an import that has already been (approved|committed)/i);
  });
});

// ============================================================================
// Phase D: Security & Access Control
// ============================================================================
describe('Phase D: Security & Access Control', () => {
  it('rejects unauthenticated requests to protected import endpoints with 401', async () => {
    // Calling without Authorization header
    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_123/approve',
      headers: {}, // No auth header
    });

    expect(statusCode).toBe(401);
    expect(body.error).toMatch(/Authentication required/i);
  });

  it('rejects access to another user pending import with 403 Forbidden', async () => {
    const foreignPending = {
      id: 'pending_foreign',
      userId: 'user_owner_abc', // owned by user_owner_abc
      filename: 'sample.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(foreignPending);

    // Request made with non-matching userId
    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_foreign/approve',
      user: { id: 'user_attacker_xyz', role: 'owner', email: 'owner@example.com' },
    });

    expect(statusCode).toBe(403);
    expect(body.error).toMatch(/not authorized to approve/i);
  });

  it('allows authorized owner to access pending imports', async () => {
    const pendingData = {
      id: 'pending_admin_ok',
      userId: 'test_user_1',
      filename: 'sample.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(pendingData);

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'GET',
      url: '/pending/pending_admin_ok',
      headers: { cookie: 'leadsync_session=owner_session_token' },
    });

    expect(statusCode).toBe(200);
    expect(body.pendingImport.id).toBe('pending_admin_ok');
  });
});

// ============================================================================
// Phase C: Real End-to-End Contract Integration Test (Extraction -> Staging -> Approval)
// ============================================================================
describe('Phase C: Real Data Contract Integration (Extraction -> Staging -> Approval)', () => {
  it('real workflow contract: extraction stages CRM records without AI skip fields, and approval commits them', async () => {
    // 1. Simulate extraction
    let stagedPendingImport: any = null;

    mockPrisma.pendingImport.create.mockImplementation(async (args: any) => {
      stagedPendingImport = {
        id: 'pending_contract_test_1',
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
        committedImportId: null,
      };
      return stagedPendingImport;
    });

    mockOrchestrateImport.mockImplementation(async (_rows, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 1,
        batchRecords: [sampleValidRecord], // CRMRecord WITHOUT skip/skipReason
        batchSkipped: [],
        batchFailed: [],
      });
      return {
        records: [sampleValidRecord],
        skipped: [],
        failed: [],
      };
    });

    const csvContent = 'Name,Email,Phone\nRahul Sharma,rahul@example.com,9876543210\n';
    const extractRes = await invokeRouter(extractRouter, {
      method: 'POST',
      url: '/',
      file: {
        originalname: 'leads.csv',
        buffer: Buffer.from(csvContent),
        mimetype: 'text/csv',
      },
    });

    expect(extractRes.statusCode).toBe(200);
    expect(mockPrisma.pendingImport.create).toHaveBeenCalledTimes(1);

    // Verify staged records in PendingImport DO NOT have AI-only skip and skipReason
    const stagedRecords = stagedPendingImport.records;
    expect(stagedRecords).toHaveLength(1);
    expect(stagedRecords[0].skip).toBeUndefined();
    expect(stagedRecords[0].skipReason).toBeUndefined();
    expect(stagedRecords[0].name).toBe('Rahul Sharma');
    expect(stagedRecords[0].email).toBe('rahul@example.com');

    // 2. Simulate human approval of the staged pending import
    mockPrisma.pendingImport.findUnique.mockResolvedValue(stagedPendingImport);

    const createdFinalImport = {
      id: 'import_committed_real_contract',
      filename: 'leads.csv',
      totalRows: 1,
      totalImported: 1,
      totalSkipped: 0,
    };

    mockPrisma.$transaction.mockImplementation(async (callback: any) => {
      const tx = {
        pendingImport: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn(),
        },
        import: {
          create: jest.fn().mockResolvedValue(createdFinalImport),
        },
      };
      return callback(tx);
    });

    const approveRes = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_contract_test_1/approve',
    });

    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.importId).toBe('import_committed_real_contract');
    expect(approveRes.body.totalImported).toBe(1);
  });

  it('proves rejection creates zero final CRM leads and purges staged data', async () => {
    const pendingToReject = {
      id: 'pending_reject_verify',
      filename: 'leads.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(pendingToReject);
    mockPrisma.pendingImport.updateMany.mockResolvedValue({ count: 1 });

    const rejectRes = await invokeRouter(importsRouter, {
      method: 'POST',
      url: '/pending_reject_verify/reject',
    });

    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.body.success).toBe(true);
    expect(rejectRes.body.status).toBe('REJECTED');

    // Verify zero writes occurred to final CRM tables
    expect(mockPrisma.import.create).not.toHaveBeenCalled();
    expect(mockPrisma.lead.create).not.toHaveBeenCalled();

    // Verify updateMany purged staged records and marked REJECTED
    const updateCall = mockPrisma.pendingImport.updateMany.mock.calls[0][0];
    expect(updateCall.data.status).toBe('REJECTED');
    expect(updateCall.data.records).toEqual([]);
    expect(updateCall.data.skipped).toEqual([]);
    expect(updateCall.data.failed).toEqual([]);
  });
});

// ============================================================================
// Phase D: Authentication & Authorization Requirements
// ============================================================================
describe('Phase D: Authentication Middleware & Integration', () => {
  beforeEach(() => {
    process.env = { ...initialEnv };
    process.env.NODE_ENV = 'test';
    process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
  });

  afterEach(() => {
    process.env = { ...initialEnv };
    process.env.NODE_ENV = 'test';
  });

  it('rejects placeholder Bearer tokens (e.g. demo-reviewer-token) without session cookie with 401', async () => {
    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'GET',
      url: '/pending/some_id',
      headers: { authorization: 'Bearer demo-reviewer-token' },
    });

    expect(statusCode).toBe(401);
    expect(body.error).toMatch(/Authentication required/i);
  });

  it('rejects requests missing leadsync_session cookie with 401', async () => {
    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'GET',
      url: '/pending/some_id',
      headers: {},
    });

    expect(statusCode).toBe(401);
    expect(body.error).toMatch(/Authentication required/i);
  });

  it('rejects non-existent session tokens with 401', async () => {
    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'GET',
      url: '/pending/some_id',
      headers: { cookie: 'leadsync_session=invalid_nonexistent_token' },
    });

    expect(statusCode).toBe(401);
    expect(body.error).toMatch(/Authentication required/i);
  });

  it('rejects expired session tokens with 401', async () => {
    mockSessions.push({
      id: 'sess_expired',
      sessionToken: 'expired_session_token',
      googleSub: 'expired_sub',
      email: 'owner@example.com',
      name: 'Expired Owner',
      picture: null,
      expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
    });

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'GET',
      url: '/pending/some_id',
      headers: { cookie: 'leadsync_session=expired_session_token' },
    });

    expect(statusCode).toBe(401);
    expect(body.error).toMatch(/Authentication required/i);
  });

  it('rejects sessions belonging to unauthorized non-owner accounts with 401', async () => {
    mockSessions.push({
      id: 'sess_unauthorized',
      sessionToken: 'unauthorized_session_token',
      googleSub: 'intruder_sub',
      email: 'intruder@example.com', // Not owner@example.com
      name: 'Intruder',
      picture: null,
      expiresAt: new Date(Date.now() + 86400000),
    });

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'GET',
      url: '/pending/some_id',
      headers: { cookie: 'leadsync_session=unauthorized_session_token' },
    });

    expect(statusCode).toBe(401);
    expect(body.error).toMatch(/Authentication required/i);
  });

  it('allows access when valid owner session cookie is provided', async () => {
    const pendingData = {
      id: 'pending_session_ok',
      userId: 'test_user_1',
      filename: 'sample.csv',
      totalRows: 1,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
      committedImportId: null,
    };

    mockPrisma.pendingImport.findUnique.mockResolvedValue(pendingData);

    const { statusCode, body } = await invokeRouter(importsRouter, {
      method: 'GET',
      url: '/pending/pending_session_ok',
      headers: { cookie: 'leadsync_session=owner_session_token' },
    });

    expect(statusCode).toBe(200);
    expect(body.pendingImport.id).toBe('pending_session_ok');
  });
});

// ============================================================================
// Phase E: SSE Stream Connection Handling & Lifecycle
// ============================================================================
describe('Phase E: SSE Connection Handling & Lifecycle', () => {
  it('delivers normal upload followed by multiple progress events and one terminal complete event', async () => {
    const csvContent = 'Name,Email,Phone\nRahul Sharma,rahul@example.com,9876543210\n';

    mockOrchestrateImport.mockImplementation(async (_rows, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 2,
        batchRecords: [sampleValidRecord],
        batchSkipped: [],
        batchFailed: [],
      });
      onEvent({
        type: 'progress',
        batchIndex: 2,
        totalBatches: 2,
        batchRecords: [],
        batchSkipped: [sampleSkippedRow],
        batchFailed: [],
      });
      return {
        records: [sampleValidRecord],
        skipped: [sampleSkippedRow],
        failed: [],
      };
    });

    mockPrisma.pendingImport.create.mockResolvedValue({
      id: 'pending_sse_1',
      filename: 'leads.csv',
      totalRows: 2,
      status: 'PENDING',
      records: [sampleValidRecord],
      skipped: [sampleSkippedRow],
      failed: [],
      expiresAt: new Date(Date.now() + 86400000),
    });

    const { statusCode, rawWrites } = await invokeRouter(extractRouter, {
      method: 'POST',
      url: '/',
      file: {
        originalname: 'leads.csv',
        buffer: Buffer.from(csvContent),
        mimetype: 'text/csv',
      },
    });

    expect(statusCode).toBe(200);

    const bodyText = rawWrites.join('');
    // Progress events
    expect(bodyText).toContain('"type":"progress","batchIndex":1');
    expect(bodyText).toContain('"type":"progress","batchIndex":2');
    // Exactly one complete event
    const completeMatches = bodyText.match(/"type":"complete"/g);
    expect(completeMatches).toHaveLength(1);
    expect(bodyText).toContain('"pendingImportId":"pending_sse_1"');
    expect(bodyText).toContain('"totalImported":0');
  });

  it('sends exactly one terminal error event on unrecoverable extraction failure', async () => {
    const csvContent = 'Name,Email\nTest,test@example.com\n';

    mockOrchestrateImport.mockRejectedValue(new Error('AI Service Unavailable'));

    const { statusCode, rawWrites } = await invokeRouter(extractRouter, {
      method: 'POST',
      url: '/',
      file: {
        originalname: 'test.csv',
        buffer: Buffer.from(csvContent),
        mimetype: 'text/csv',
      },
    });

    expect(statusCode).toBe(200);
    const bodyText = rawWrites.join('');
    const errorMatches = bodyText.match(/"type":"error"/g);
    expect(errorMatches).toHaveLength(1);
    expect(bodyText).toContain('AI Service Unavailable');
    expect(bodyText).not.toContain('"type":"complete"');
  });
});
