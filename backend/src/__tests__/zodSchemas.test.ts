/**
 * Tests for the strict Zod validation schemas (zodSchemas.service.ts).
 * Verifies strict validation, mandatory fields, rejection of unexpected fields,
 * and that malformed values are rejected rather than silently converted to null.
 */
import {
  validateAIRow,
  validateAIBatch,
  AIExtractedRowSchema,
} from '../services/zodSchemas.service';

const baseValidRow = {
  created_at: '2024-05-13T00:00:00.000Z',
  name: 'Alice Smith',
  email: 'alice@example.com',
  country_code: '+91',
  mobile_without_country_code: '9876543210',
  company: 'Acme Corp',
  city: 'Mumbai',
  state: 'Maharashtra',
  country: 'India',
  lead_owner: 'Bob',
  crm_status: 'GOOD_LEAD_FOLLOW_UP',
  crm_note: 'Initial inquiry note',
  data_source: 'eden_park',
  possession_time: 'Dec 2025',
  description: 'Looking for 3BHK',
  skip: false,
  skipReason: null,
};

// ---------------------------------------------------------------------------
// Basic Object & Contract Validation
// ---------------------------------------------------------------------------
describe('validateAIRow — structure & contract completeness', () => {
  it('accepts a complete valid row', () => {
    const result = validateAIRow(baseValidRow);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('alice@example.com');
      expect(result.data.crm_status).toBe('GOOD_LEAD_FOLLOW_UP');
      expect(result.data.data_source).toBe('eden_park');
      expect(result.data.country_code).toBe('+91');
      expect(result.data.mobile_without_country_code).toBe('9876543210');
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

  it('rejects unexpected/hallucinated fields (strict schema enforcement)', () => {
    const rowWithExtra = {
      ...baseValidRow,
      hallucinated_column: 'unexpected data',
    };
    const result = validateAIRow(rowWithExtra);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.message.includes('Unrecognized key'))).toBe(true);
    }
  });

  it('rejects rows with missing mandatory contract fields', () => {
    const { email: _omit, ...rowMissingEmailKey } = baseValidRow;
    const result = validateAIRow(rowMissingEmailKey);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes('email'))).toBe(true);
    }
  });

  it('accepts explicit null for nullable contract fields', () => {
    const rowWithNulls = {
      ...baseValidRow,
      created_at: null,
      company: null,
      city: null,
      state: null,
      country: null,
      crm_note: null,
      possession_time: null,
      description: null,
      crm_status: null,
      data_source: null,
    };
    const result = validateAIRow(rowWithNulls);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.company).toBeNull();
      expect(result.data.city).toBeNull();
      expect(result.data.crm_status).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Email Validation
// ---------------------------------------------------------------------------
describe('validateAIRow — email strict validation & normalization', () => {
  it('accepts a valid email and normalizes it to lowercase', () => {
    const result = validateAIRow({
      ...baseValidRow,
      email: 'ALICE.SMITH@DOMAIN.CO.UK',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('alice.smith@domain.co.uk');
    }
  });

  it('rejects malformed email instead of silently converting to null', () => {
    const result = validateAIRow({
      ...baseValidRow,
      email: 'not-an-email-address',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes('email'))).toBe(true);
    }
  });

  it('rejects email missing a domain extension instead of silently converting to null', () => {
    const result = validateAIRow({
      ...baseValidRow,
      email: 'user@domain',
    });
    expect(result.success).toBe(false);
  });

  it('allows explicit null email when mobile contact is present', () => {
    const result = validateAIRow({
      ...baseValidRow,
      email: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Country Code Validation
// ---------------------------------------------------------------------------
describe('validateAIRow — country_code strict validation', () => {
  it('accepts valid country codes', () => {
    const codes = ['+1', '+91', '+44', '+971'];
    for (const code of codes) {
      const result = validateAIRow({ ...baseValidRow, country_code: code });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.country_code).toBe(code);
    }
  });

  it('rejects country code without leading + instead of silently converting to null', () => {
    const result = validateAIRow({ ...baseValidRow, country_code: '91' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes('country_code'))).toBe(true);
    }
  });

  it('rejects text country code instead of silently converting to null', () => {
    const result = validateAIRow({ ...baseValidRow, country_code: 'India' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mobile Number Validation
// ---------------------------------------------------------------------------
describe('validateAIRow — mobile number strict validation', () => {
  it('accepts a 10-digit number and strips punctuation', () => {
    const result = validateAIRow({
      ...baseValidRow,
      mobile_without_country_code: '987-654-3210',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mobile_without_country_code).toBe('9876543210');
    }
  });

  it('rejects a too-short number (<5 digits) instead of silently converting to null', () => {
    const result = validateAIRow({
      ...baseValidRow,
      mobile_without_country_code: '123',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes('mobile_without_country_code'))).toBe(true);
    }
  });

  it('rejects an invalid alphabetic phone number instead of silently converting to null', () => {
    const result = validateAIRow({
      ...baseValidRow,
      mobile_without_country_code: 'call-me-now',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Date Validation
// ---------------------------------------------------------------------------
describe('validateAIRow — created_at date strict validation', () => {
  it('accepts a valid ISO date and returns its ISO string', () => {
    const result = validateAIRow({
      ...baseValidRow,
      created_at: '2024-05-13T14:20:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created_at).toBe('2024-05-13T14:20:00.000Z');
    }
  });

  it('normalizes common parseable dates to ISO format', () => {
    const result = validateAIRow({
      ...baseValidRow,
      created_at: '2024-05-13',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created_at).toMatch(/^2024-05-13T/);
    }
  });

  it('rejects unparseable date strings instead of silently converting to null', () => {
    const result = validateAIRow({
      ...baseValidRow,
      created_at: 'not-a-real-date',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes('created_at'))).toBe(true);
    }
  });

  it('accepts explicit null date', () => {
    const result = validateAIRow({
      ...baseValidRow,
      created_at: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created_at).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// CRM Status & Data Source Validation
// ---------------------------------------------------------------------------
describe('validateAIRow — crm_status & data_source strict validation', () => {
  it('accepts and normalizes valid crm_status values', () => {
    const statuses = ['GOOD_LEAD_FOLLOW_UP', 'DID_NOT_CONNECT', 'BAD_LEAD', 'SALE_DONE'];
    for (const s of statuses) {
      const result = validateAIRow({ ...baseValidRow, crm_status: s.toLowerCase() });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.crm_status).toBe(s);
    }
  });

  it('rejects unsupported crm_status values instead of silently converting to null', () => {
    const result = validateAIRow({ ...baseValidRow, crm_status: 'HOT_LEAD' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes('crm_status'))).toBe(true);
    }
  });

  it('accepts and normalizes valid data_source values', () => {
    const sources = ['leads_on_demand', 'meridian_tower', 'eden_park', 'varah_swamy', 'sarjapur_plots'];
    for (const src of sources) {
      const result = validateAIRow({ ...baseValidRow, data_source: src.toUpperCase() });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.data_source).toBe(src);
    }
  });

  it('rejects unsupported data_source values instead of silently converting to null', () => {
    const result = validateAIRow({ ...baseValidRow, data_source: 'unsupported_vendor' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes('data_source'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Batch Validation
// ---------------------------------------------------------------------------
describe('validateAIBatch — structural validation & length matching', () => {
  it('throws an error eligible for retry when input is not an array', () => {
    expect(() => validateAIBatch({ foo: 'bar' }, 1)).toThrow(/eligible for retry/i);
  });

  it('throws an error eligible for retry when array length does not match expected length', () => {
    expect(() => validateAIBatch([baseValidRow], 2)).toThrow(/eligible for retry/i);
  });

  it('returns per-row success/failure results preserving 1-to-1 correspondence', () => {
    const batch = [
      baseValidRow,
      { ...baseValidRow, email: 'not-an-email' }, // invalid row
    ];

    const results = validateAIBatch(batch, 2);
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
  });
});
