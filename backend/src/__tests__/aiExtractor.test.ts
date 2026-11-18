/**
 * Tests for the AI extractor service.
 *
 * All Gemini API calls are mocked — no paid API calls required.
 */

// Set env before any module is loaded
process.env.GEMINI_API_KEY = 'test-key';

// The mock must be declared before imports. The mock factory captures a reference
// to a shared mock function so individual tests can configure it via mockImplementation.
const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn(() => ({
  generateContent: mockGenerateContent,
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
}));

// Also reset the module-level singleton (model) between tests by re-importing
// the module fresh each time. We use jest.isolateModules to get a fresh copy.
import type { RawRow } from '../types';

function makeResponse(text: string) {
  return { response: { text: () => text } };
}

const sampleRawRows: RawRow[] = [
  { Name: 'Alice', Email: 'alice@example.com', Phone: '+91 9876543210' },
  { Name: 'Bob', Email: 'bob@example.com', Phone: '8765432109' },
];

const validExtractedArray = [
  {
    created_at: '2024-05-13T00:00:00.000Z',
    name: 'Alice',
    email: 'alice@example.com',
    country_code: '+91',
    mobile_without_country_code: '9876543210',
    company: null,
    city: null,
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
  {
    created_at: null,
    name: 'Bob',
    email: 'bob@example.com',
    country_code: null,
    mobile_without_country_code: '8765432109',
    company: null,
    city: null,
    state: null,
    country: null,
    lead_owner: null,
    crm_status: null,
    crm_note: null,
    data_source: null,
    possession_time: null,
    description: null,
    skip: false,
    skipReason: null,
  },
];

beforeEach(() => {
  mockGenerateContent.mockReset();
});

// Helper: get a fresh extractBatch with the singleton model reset
// Since the model is a module-level singleton, we need a fresh import each time
// to avoid stale state across tests. We use jest.isolateModules for this.
async function runExtractBatch(rows: RawRow[]) {
  let extractBatch: (rows: RawRow[]) => Promise<import('../types').BatchResult>;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    extractBatch = require('../services/aiExtractor.service').extractBatch;
  });
  return extractBatch!(rows);
}

// ---------------------------------------------------------------------------
// Correct, complete Gemini JSON responses
// ---------------------------------------------------------------------------
describe('extractBatch — valid responses', () => {
  it('processes a correct, complete Gemini JSON response', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(JSON.stringify(validExtractedArray))
    );

    const result = await runExtractBatch(sampleRawRows);

    expect(result.records).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.records[0].email).toBe('alice@example.com');
    expect(result.records[0].crm_status).toBe('GOOD_LEAD_FOLLOW_UP');
  });

  it('strips markdown code fences from the response', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse('```json\n' + JSON.stringify(validExtractedArray) + '\n```')
    );

    const result = await runExtractBatch(sampleRawRows);
    expect(result.records).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it('normalizes crm_status case-insensitively', async () => {
    const rows: RawRow[] = [{ Name: 'Carol', Email: 'carol@example.com' }];
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], name: 'Carol', email: 'carol@example.com', crm_status: 'good_lead_follow_up' },
        ])
      )
    );

    const result = await runExtractBatch(rows);
    expect(result.records[0].crm_status).toBe('GOOD_LEAD_FOLLOW_UP');
  });

  it('normalizes data_source case-insensitively', async () => {
    const rows: RawRow[] = [{ Name: 'Dan', Email: 'dan@example.com' }];
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], name: 'Dan', email: 'dan@example.com', data_source: 'EDEN_PARK' },
        ])
      )
    );

    const result = await runExtractBatch(rows);
    expect(result.records[0].data_source).toBe('eden_park');
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON
// ---------------------------------------------------------------------------
describe('extractBatch — malformed JSON', () => {
  it('throws an eligible-for-retry error on completely invalid JSON', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse('This is not JSON at all')
    );

    await expect(runExtractBatch(sampleRawRows)).rejects.toThrow(/eligible for retry/i);
  });

  it('throws on a JSON object (not array) response', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse('{ "error": "I could not parse this" }')
    );

    await expect(runExtractBatch(sampleRawRows)).rejects.toThrow(/eligible for retry/i);
  });

  it('throws on a JSON string response', async () => {
    mockGenerateContent.mockResolvedValueOnce(makeResponse('"just a string"'));

    await expect(runExtractBatch(sampleRawRows)).rejects.toThrow(/eligible for retry/i);
  });
});

// ---------------------------------------------------------------------------
// Incorrect response array length
// ---------------------------------------------------------------------------
describe('extractBatch — wrong array length', () => {
  it('throws an eligible-for-retry error when AI returns fewer rows than requested', async () => {
    // Only 1 row for a 2-row batch
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(JSON.stringify([validExtractedArray[0]]))
    );

    await expect(runExtractBatch(sampleRawRows)).rejects.toThrow(/eligible for retry/i);
  });

  it('throws an eligible-for-retry error when AI returns more rows than requested', async () => {
    // 3 rows for a 2-row batch
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([...validExtractedArray, validExtractedArray[0]])
      )
    );

    await expect(runExtractBatch(sampleRawRows)).rejects.toThrow(/eligible for retry/i);
  });
});

// ---------------------------------------------------------------------------
// Missing required fields / incorrect field types
// ---------------------------------------------------------------------------
describe('extractBatch — field-level validation', () => {
  it('reports a row as failed when it is not an object', async () => {
    // The batch array has correct length but element is a string
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(JSON.stringify(['not-an-object', validExtractedArray[1]]))
    );

    const result = await runExtractBatch(sampleRawRows);
    expect(result.failed).toHaveLength(1);
    expect(result.records).toHaveLength(1);
  });

  it('defaults missing optional fields to null rather than failing the row', async () => {
    // Row with just email — all other fields missing
    const minimal = [{ email: 'eve@example.com' }, { email: 'frank@example.com' }];
    mockGenerateContent.mockResolvedValueOnce(makeResponse(JSON.stringify(minimal)));

    const result = await runExtractBatch(sampleRawRows);
    expect(result.failed).toHaveLength(0);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].name).toBeNull();
    expect(result.records[0].crm_status).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invalid status and data-source values
// ---------------------------------------------------------------------------
describe('extractBatch — invalid enum values', () => {
  it('converts an invalid crm_status to null', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], crm_status: 'HOT_LEAD' },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    expect(result.records[0].crm_status).toBeNull();
  });

  it('converts an invalid data_source to null', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], data_source: 'facebook_ads' },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    expect(result.records[0].data_source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invalid dates
// ---------------------------------------------------------------------------
describe('extractBatch — date validation', () => {
  it('converts a valid ISO date correctly', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], created_at: '2024-05-13T14:20:00.000Z' },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    expect(result.records[0].created_at).toBe('2024-05-13T14:20:00.000Z');
  });

  it('converts an unparseable date to null (not forward garbage to Prisma)', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], created_at: 'not-a-date-at-all' },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    // Must be null — invalid dates must never reach Prisma
    expect(result.records[0].created_at).toBeNull();
  });

  it('converts an empty string date to null', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], created_at: '' },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    expect(result.records[0].created_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invalid email
// ---------------------------------------------------------------------------
describe('extractBatch — email validation', () => {
  it('converts a malformed email to null but keeps the row if mobile is valid', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], email: 'not-an-email' },
          { ...validExtractedArray[1], email: 'also-not@@email.com' },
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    // Both rows have valid mobiles so they should be records, not skipped
    expect(result.records[0].email).toBeNull();
    expect(result.records[1].email).toBeNull();
    expect(result.skipped).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invalid phone numbers
// ---------------------------------------------------------------------------
describe('extractBatch — phone validation', () => {
  it('converts a too-short mobile number to null', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], mobile_without_country_code: '123' },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    // row[0] still has a valid email so it should be a record with null mobile
    expect(result.records[0].mobile_without_country_code).toBeNull();
    expect(result.records[0].email).toBe('alice@example.com');
  });

  it('converts an invalid country code format to null', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          { ...validExtractedArray[0], country_code: 'India' },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    expect(result.records[0].country_code).toBeNull();
    // Mobile should still be there
    expect(result.records[0].mobile_without_country_code).toBe('9876543210');
  });
});

// ---------------------------------------------------------------------------
// AI-provided skip flags conflicting with validated contact data
// ---------------------------------------------------------------------------
describe('extractBatch — server-side skip override', () => {
  it('does NOT skip a row that the AI says skip=true when it has valid email', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          // AI says skip but there's a valid email
          { ...validExtractedArray[0], skip: true, skipReason: 'No contact info' },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    // Server should override — row has email so it's processed, not skipped
    expect(result.records).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.records[0].email).toBe('alice@example.com');
  });

  it('does NOT skip a row that the AI says skip=true when it has valid mobile', async () => {
    const rowWithMobileOnly = {
      ...validExtractedArray[0],
      email: null, // no email
      skip: true,
      skipReason: 'No email found',
    };
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([rowWithMobileOnly, validExtractedArray[1]])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    // Has mobile — must not be skipped despite AI saying skip=true
    expect(result.skipped).toHaveLength(0);
    expect(result.records).toHaveLength(2);
  });

  it('skips a row when server determines there is truly no contact info', async () => {
    mockGenerateContent.mockResolvedValueOnce(
      makeResponse(
        JSON.stringify([
          // No email, no mobile
          { ...validExtractedArray[0], email: null, mobile_without_country_code: null, country_code: null, skip: false },
          validExtractedArray[1],
        ])
      )
    );

    const result = await runExtractBatch(sampleRawRows);
    expect(result.skipped).toHaveLength(1);
    expect(result.records).toHaveLength(1);
    // The skipped row should be the first one
    expect(result.skipped[0].reason).toBe('No email or mobile number found');
  });
});

// ---------------------------------------------------------------------------
// withRetry — retry exhaustion
// ---------------------------------------------------------------------------
describe('withRetry', () => {
  it('retries the specified number of times then throws', async () => {
    // Import withRetry directly (not through the model singleton)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { withRetry } = require('../services/aiExtractor.service');

    const fn = jest.fn().mockRejectedValue(new Error('AI failure — eligible for retry'));

    await expect(withRetry(fn, 3, 1)).rejects.toThrow('AI failure');
    // withRetry is called with maxAttempts=3 so fn should be called 3 times
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('succeeds on the second attempt after first failure', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { withRetry } = require('../services/aiExtractor.service');

    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary error'))
      .mockResolvedValueOnce('success');

    const result = await withRetry(fn, 3, 1);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('resolves immediately when the first attempt succeeds', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { withRetry } = require('../services/aiExtractor.service');

    const fn = jest.fn().mockResolvedValueOnce('ok');

    const result = await withRetry(fn, 3, 10);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
