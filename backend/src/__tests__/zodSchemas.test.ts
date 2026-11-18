/**
 * Tests for the Zod validation schemas (zodSchemas.service.ts).
 */
import {
  validateAIRow,
  validateAIBatch,
  AIExtractedRowSchema,
} from '../services/zodSchemas.service';

// ---------------------------------------------------------------------------
// validateAIRow
// ---------------------------------------------------------------------------
describe('validateAIRow — basic object validation', () => {
  it('accepts a complete valid row', () => {
    const row = {
      created_at: '2024-05-13T00:00:00.000Z',
      name: 'Alice',
      email: 'alice@example.com',
      country_code: '+91',
      mobile_without_country_code: '9876543210',
      company: 'Acme',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      lead_owner: 'Bob',
      crm_status: 'GOOD_LEAD_FOLLOW_UP',
      crm_note: 'Some note',
      data_source: 'eden_park',
      possession_time: 'Dec 2025',
      description: 'A description',
      skip: false,
      skipReason: null,
    };

    const result = validateAIRow(row);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('alice@example.com');
      expect(result.data.crm_status).toBe('GOOD_LEAD_FOLLOW_UP');
      expect(result.data.data_source).toBe('eden_park');
    }
  });

  it('rejects a non-object (array)', () => {
    const result = validateAIRow([]);
    expect(result.success).toBe(false);
  });

  it('rejects a non-object (string)', () => {
    const result = validateAIRow('just a string');
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = validateAIRow(null);
    expect(result.success).toBe(false);
  });

  it('defaults missing fields to null', () => {
    const result = validateAIRow({ email: 'test@example.com' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBeNull();
      expect(result.data.crm_status).toBeNull();
      expect(result.data.country_code).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------
describe('validateAIRow — email', () => {
  it('accepts a valid email', () => {
    const result = validateAIRow({ email: 'valid@domain.co.uk' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('valid@domain.co.uk');
  });

  it('lowercases a valid email', () => {
    const result = validateAIRow({ email: 'TEST@EXAMPLE.COM' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe('test@example.com');
  });

  it('converts a malformed email to null', () => {
    const result = validateAIRow({ email: 'not-an-email', mobile_without_country_code: '9876543210' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBeNull();
  });

  it('converts an email with no TLD to null', () => {
    const result = validateAIRow({ email: 'user@domain', mobile_without_country_code: '9876543210' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Country code validation
// ---------------------------------------------------------------------------
describe('validateAIRow — country_code', () => {
  it('accepts valid country codes', () => {
    const cases = ['+1', '+91', '+44', '+971'];
    for (const cc of cases) {
      const result = validateAIRow({ email: 'test@example.com', country_code: cc });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.country_code).toBe(cc);
    }
  });

  it('converts a country code without + to null', () => {
    const result = validateAIRow({ email: 'test@example.com', country_code: '91' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.country_code).toBeNull();
  });

  it('converts a text country code to null', () => {
    const result = validateAIRow({ email: 'test@example.com', country_code: 'India' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.country_code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mobile number validation
// ---------------------------------------------------------------------------
describe('validateAIRow — mobile_without_country_code', () => {
  it('accepts a 10-digit number', () => {
    const result = validateAIRow({ email: 'test@example.com', mobile_without_country_code: '9876543210' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mobile_without_country_code).toBe('9876543210');
  });

  it('converts a too-short number to null', () => {
    const result = validateAIRow({ email: 'test@example.com', mobile_without_country_code: '123' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mobile_without_country_code).toBeNull();
  });

  it('strips non-digit characters from mobile', () => {
    const result = validateAIRow({ email: 'test@example.com', mobile_without_country_code: '987-654-3210' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mobile_without_country_code).toBe('9876543210');
  });
});

// ---------------------------------------------------------------------------
// Date validation
// ---------------------------------------------------------------------------
describe('validateAIRow — created_at', () => {
  it('accepts a valid ISO date and returns its ISO string', () => {
    const result = validateAIRow({
      email: 'test@example.com',
      created_at: '2024-05-13T14:20:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.created_at).toBe('2024-05-13T14:20:00.000Z');
  });

  it('converts an unparseable date string to null', () => {
    const result = validateAIRow({ email: 'test@example.com', created_at: 'not-a-date' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.created_at).toBeNull();
  });

  it('converts an empty date string to null', () => {
    const result = validateAIRow({ email: 'test@example.com', created_at: '' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.created_at).toBeNull();
  });

  it('converts a "null" string date to null', () => {
    const result = validateAIRow({ email: 'test@example.com', created_at: 'null' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.created_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// crm_status and data_source validation
// ---------------------------------------------------------------------------
describe('validateAIRow — crm_status', () => {
  it('accepts all valid crm_status values', () => {
    const statuses = ['GOOD_LEAD_FOLLOW_UP', 'DID_NOT_CONNECT', 'BAD_LEAD', 'SALE_DONE'];
    for (const s of statuses) {
      const result = validateAIRow({ email: 'test@example.com', crm_status: s });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.crm_status).toBe(s);
    }
  });

  it('normalizes crm_status case-insensitively', () => {
    const result = validateAIRow({ email: 'test@example.com', crm_status: 'good_lead_follow_up' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.crm_status).toBe('GOOD_LEAD_FOLLOW_UP');
  });

  it('converts an invalid crm_status to null', () => {
    const result = validateAIRow({ email: 'test@example.com', crm_status: 'INTERESTED' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.crm_status).toBeNull();
  });
});

describe('validateAIRow — data_source', () => {
  it('accepts all valid data_source values', () => {
    const sources = ['leads_on_demand', 'meridian_tower', 'eden_park', 'varah_swamy', 'sarjapur_plots'];
    for (const src of sources) {
      const result = validateAIRow({ email: 'test@example.com', data_source: src });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.data_source).toBe(src);
    }
  });

  it('normalizes data_source case-insensitively', () => {
    const result = validateAIRow({ email: 'test@example.com', data_source: 'EDEN_PARK' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.data_source).toBe('eden_park');
  });

  it('converts an invalid data_source to null', () => {
    const result = validateAIRow({ email: 'test@example.com', data_source: 'facebook' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.data_source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// skip field — AI-provided skip hint handling
// ---------------------------------------------------------------------------
describe('validateAIRow — skip field', () => {
  it('accepts boolean skip=true', () => {
    const result = validateAIRow({ email: 'test@example.com', skip: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skip).toBe(true);
  });

  it('converts string "true" to boolean true', () => {
    const result = validateAIRow({ email: 'test@example.com', skip: 'true' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skip).toBe(true);
  });

  it('defaults missing skip to false', () => {
    const result = validateAIRow({ email: 'test@example.com' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateAIBatch — structural validation
// ---------------------------------------------------------------------------
describe('validateAIBatch — structural validation', () => {
  it('throws when input is not an array', () => {
    expect(() => validateAIBatch({ foo: 'bar' }, 1)).toThrow(/eligible for retry/i);
  });

  it('throws when array length does not match expectedLength', () => {
    expect(() => validateAIBatch([{ email: 'a@a.com' }], 2)).toThrow(/eligible for retry/i);
  });

  it('returns per-row success/failure results', () => {
    const batch = [
      { email: 'valid@example.com' },   // valid
      'not-an-object',                   // invalid
    ];

    const results = validateAIBatch(batch, 2);
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
  });

  it('succeeds for all valid rows', () => {
    const batch = [
      { email: 'a@example.com' },
      { mobile_without_country_code: '9876543210' },
    ];

    const results = validateAIBatch(batch, 2);
    expect(results.every((r) => r.success)).toBe(true);
  });
});
