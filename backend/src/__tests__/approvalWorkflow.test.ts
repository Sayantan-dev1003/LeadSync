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
jest.mock('../lib/prisma', () => {
  const mockPrisma = {
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
      headers: {},
    };

    const finish = (statusCode: number, body: any) => {
      if (resolved) return;
      resolved = true;
      resolve({ statusCode, body, rawWrites });
    };

    const res: any = {
      statusCode: 200,
      headers: {},
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
        rawWrites.push(chunk ? chunk.toString() : '');
        return true;
      },
      end() {
        if (!resolved) {
          finish(this.statusCode, rawWrites.join(''));
        }
      },
    };

    router(req, res, (err: any) => {
      if (err) reject(err);
      else finish(res.statusCode, null);
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
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
    mockPrisma.pendingImport.update.mockResolvedValue({
      ...pendingData,
      status: 'REJECTED',
      records: [],
    });

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

    // Verify staged records were wiped to purge PII
    expect(mockPrisma.pendingImport.update).toHaveBeenCalledWith({
      where: { id: 'pending_to_reject' },
      data: {
        status: 'REJECTED',
        records: [],
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
    expect(body.error).toMatch(/Cannot reject an import that has already been committed/i);
  });
});
