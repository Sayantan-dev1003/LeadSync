/**
 * Zod schemas for validating AI-generated CRM extraction responses.
 * All AI output must pass these schemas before being trusted as TypeScript types.
 */
import { z } from 'zod';
import { CRM_STATUS_VALUES, DATA_SOURCE_VALUES } from '../types';
import { normalizeDateString } from './validators.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a string-or-null field: trim whitespace, convert empty strings and
 * "null"/"undefined" literals to null.
 * Requires the key to be explicitly present (can be null).
 */
export const nullableString = z
  .union([z.string(), z.null()])
  .transform((v): string | null => {
    if (v === null) return null;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') {
      return null;
    }
    return trimmed;
  });

// ---------------------------------------------------------------------------
// Field-level validators
// ---------------------------------------------------------------------------

/**
 * Validates an ISO 8601 date string or null.
 * - Accepts strings that parse to a valid Date.
 * - Normalizes to ISO 8601.
 * - Rejects malformed non-null dates with validation error (never silently converts to null).
 */
export const isoDateOrNull = z
  .union([z.string(), z.null()])
  .superRefine((v, ctx) => {
    if (v === null) return;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return;
    const normalized = normalizeDateString(trimmed);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid date format: "${trimmed}". Must parse to a valid date`,
      });
    }
  })
  .transform((v): string | null => {
    if (v === null) return null;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    return normalizeDateString(trimmed);
  });

/**
 * Email: must look like a valid email, or null.
 * - If non-null and not an email, fails validation with an error.
 * - Does NOT silently convert malformed emails to null.
 */
export const emailOrNull = z
  .union([z.string(), z.null()])
  .superRefine((v, ctx) => {
    if (v === null) return;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return;
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid email format: "${trimmed}"`,
      });
    }
  })
  .transform((v): string | null => {
    if (v === null) return null;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    return trimmed.toLowerCase();
  });

/**
 * Country code: must start with + and contain 1-4 digits, or null.
 * E.g. "+91", "+1", "+44", "+971".
 * - If non-null and invalid, fails validation with an error.
 */
export const countryCodeOrNull = z
  .union([z.string(), z.null()])
  .superRefine((v, ctx) => {
    if (v === null) return;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return;
    const countryCodePattern = /^\+\d{1,4}$/;
    if (!countryCodePattern.test(trimmed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid country code: "${trimmed}". Must start with + followed by 1 to 4 digits`,
      });
    }
  })
  .transform((v): string | null => {
    if (v === null) return null;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    return trimmed;
  });

/**
 * Mobile number: digits only (can normalize out spaces/dashes), or null.
 * Must be between 5 and 15 digits (ITU-T E.164 range).
 * - If non-null and invalid, fails validation with an error.
 */
export const mobileOrNull = z
  .union([z.string(), z.null()])
  .superRefine((v, ctx) => {
    if (v === null) return;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return;
    const digits = trimmed.replace(/[\s\-().+]/g, '').replace(/\D/g, '');
    if (digits.length < 5 || digits.length > 15) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid mobile number: "${trimmed}". Must contain between 5 and 15 digits`,
      });
    }
  })
  .transform((v): string | null => {
    if (v === null) return null;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    return trimmed.replace(/[\s\-().+]/g, '').replace(/\D/g, '');
  });

/**
 * crm_status: one of the allowed enum values (case-insensitive normalised to
 * upper-case), or null.
 * - If non-null and not an allowed value, fails validation.
 */
export const crmStatusOrNull = z
  .union([z.string(), z.null()])
  .superRefine((v, ctx) => {
    if (v === null) return;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return;
    const normalised = trimmed.toUpperCase();
    if (!(CRM_STATUS_VALUES as readonly string[]).includes(normalised)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid crm_status: "${trimmed}". Must be one of ${CRM_STATUS_VALUES.join(', ')} or null`,
      });
    }
  })
  .transform((v): (typeof CRM_STATUS_VALUES)[number] | null => {
    if (v === null) return null;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    return trimmed.toUpperCase() as (typeof CRM_STATUS_VALUES)[number];
  });

/**
 * data_source: one of the allowed enum values (case-insensitive normalised to
 * lower-case), or null.
 * - If non-null and not an allowed value, fails validation.
 */
export const dataSourceOrNull = z
  .union([z.string(), z.null()])
  .superRefine((v, ctx) => {
    if (v === null) return;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return;
    const normalised = trimmed.toLowerCase();
    if (!(DATA_SOURCE_VALUES as readonly string[]).includes(normalised)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid data_source: "${trimmed}". Must be one of ${DATA_SOURCE_VALUES.join(', ')} or null`,
      });
    }
  })
  .transform((v): (typeof DATA_SOURCE_VALUES)[number] | null => {
    if (v === null) return null;
    const trimmed = String(v).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    return trimmed.toLowerCase() as (typeof DATA_SOURCE_VALUES)[number];
  });

export const skipField = z
  .union([z.boolean(), z.string(), z.null()])
  .transform((v): boolean => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.toLowerCase() === 'true';
    return false;
  });

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

/**
 * Shared CRM field validators matching the 15 standard CRM fields.
 * Reused between CRMRecordSchema and AIExtractedRowSchema to prevent schema drift.
 */
export const crmFieldsShape = {
  created_at: isoDateOrNull,
  name: nullableString,
  email: emailOrNull,
  country_code: countryCodeOrNull,
  mobile_without_country_code: mobileOrNull,
  company: nullableString,
  city: nullableString,
  state: nullableString,
  country: nullableString,
  lead_owner: nullableString,
  crm_status: crmStatusOrNull,
  crm_note: nullableString,
  data_source: dataSourceOrNull,
  possession_time: nullableString,
  description: nullableString,
};

/**
 * Dedicated schema for normalized, staged CRM records awaiting human approval and persistence.
 * Strict: rejects unexpected fields (including AI-only fields like skip and skipReason).
 * Explicit: all 15 CRM contract keys must be present (nullable fields can be null).
 */
export const CRMRecordSchema = z.object(crmFieldsShape).strict();

export type ValidatedCRMRecord = z.output<typeof CRMRecordSchema>;

/**
 * Validates a single staged CRM record before database persistence.
 * Returns { success: true, data } or { success: false, error }.
 */
export function validateCRMRecord(raw: unknown): z.SafeParseReturnType<unknown, ValidatedCRMRecord> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [],
          message: `Expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`,
        },
      ]),
    };
  }
  return CRMRecordSchema.safeParse(raw);
}

/**
 * Schema for a single raw AI-extracted row from Gemini (including the skip hint fields).
 * Strict: rejects unexpected fields.
 * Explicit: all 17 keys must be present (nullable fields can be null).
 */
export const AIExtractedRowSchema = z
  .object({
    ...crmFieldsShape,
    skip: skipField,
    skipReason: nullableString,
  })
  .strict();

export type ValidatedAIRow = z.output<typeof AIExtractedRowSchema>;

/**
 * Validates a single raw AI-output object.
 * Returns { success: true, data } or { success: false, error }.
 */
export function validateAIRow(raw: unknown): z.SafeParseReturnType<unknown, ValidatedAIRow> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [],
          message: `Expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`,
        },
      ]),
    };
  }
  return AIExtractedRowSchema.safeParse(raw);
}

/**
 * Validates an entire AI batch response.
 * - Ensures it is an array.
 * - Ensures it has the expected length.
 * - Validates every element.
 *
 * Throws a descriptive Error that is eligible for retry if the structure is
 * unrecoverable (wrong type or length).
 *
 * Returns per-row results so individual row failures can be surfaced without
 * failing the whole batch.
 */
export function validateAIBatch(
  parsed: unknown,
  expectedLength: number
): Array<{ success: true; data: ValidatedAIRow } | { success: false; error: string }> {
  if (!Array.isArray(parsed)) {
    throw new Error('AI response is not a JSON array — eligible for retry');
  }

  if (parsed.length !== expectedLength) {
    throw new Error(
      `AI returned ${parsed.length} records for a batch of ${expectedLength} — eligible for retry`
    );
  }

  return parsed.map((item, index) => {
    const result = validateAIRow(item);
    if (result.success) {
      return { success: true as const, data: result.data };
    }
    const messages = result.error.errors.map((e) => e.message).join('; ');
    return {
      success: false as const,
      error: `Row ${index}: ${messages}`,
    };
  });
}
