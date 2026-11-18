/**
 * Zod schemas for validating AI-generated CRM extraction responses.
 * All AI output must pass these schemas before being trusted as TypeScript types.
 */
import { z } from 'zod';
import { CRM_STATUS_VALUES, DATA_SOURCE_VALUES } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a string-or-null field: trim whitespace, convert empty strings and
 * "null"/"undefined" literals to null.
 */
const nullableString = z
  .union([z.string(), z.null()])
  .nullable()
  .optional()
  .transform((v): string | null => {
    if (v == null) return null;
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
 * - Returns null for unparseable dates (never passes garbage to Prisma).
 */
export const isoDateOrNull = z
  .union([z.string(), z.null()])
  .nullable()
  .optional()
  .transform((v): string | null => {
    if (v == null) return null;
    const trimmed = String(v).trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return null;
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) return null; // Invalid date → null, never forward garbage
    return d.toISOString();
  });

/**
 * Email: must look like an email (basic RFC-ish check), or null.
 * Rejects obviously malformed strings without hard-failing the row.
 */
export const emailOrNull = z
  .union([z.string(), z.null()])
  .nullable()
  .optional()
  .transform((v): string | null => {
    if (v == null) return null;
    const trimmed = String(v).trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return null;
    // Basic email pattern: something@something.something
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(trimmed)) return null;
    return trimmed.toLowerCase();
  });

/**
 * Country code: must start with + and contain 1-4 digits, or null.
 * E.g. "+91", "+1", "+44", "+971".
 */
export const countryCodeOrNull = z
  .union([z.string(), z.null()])
  .nullable()
  .optional()
  .transform((v): string | null => {
    if (v == null) return null;
    const trimmed = String(v).trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return null;
    const countryCodePattern = /^\+\d{1,4}$/;
    if (!countryCodePattern.test(trimmed)) return null;
    return trimmed;
  });

/**
 * Mobile number: digits only (stripped of spaces/dashes), or null.
 * Must be between 5 and 15 digits (ITU-T E.164 range).
 */
export const mobileOrNull = z
  .union([z.string(), z.null()])
  .nullable()
  .optional()
  .transform((v): string | null => {
    if (v == null) return null;
    const trimmed = String(v).trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return null;
    const digits = trimmed.replace(/[\s\-().+]/g, '').replace(/\D/g, '');
    if (digits.length < 5 || digits.length > 15) return null;
    return digits;
  });

/**
 * crm_status: one of the allowed enum values (case-insensitive normalised to
 * upper-case), or null.
 */
export const crmStatusOrNull = z
  .union([z.string(), z.null()])
  .nullable()
  .optional()
  .transform((v): (typeof CRM_STATUS_VALUES)[number] | null => {
    if (v == null) return null;
    const normalised = String(v).trim().toUpperCase();
    if ((CRM_STATUS_VALUES as readonly string[]).includes(normalised)) {
      return normalised as (typeof CRM_STATUS_VALUES)[number];
    }
    return null;
  });

/**
 * data_source: one of the allowed enum values (case-insensitive normalised to
 * lower-case), or null.
 */
export const dataSourceOrNull = z
  .union([z.string(), z.null()])
  .nullable()
  .optional()
  .transform((v): (typeof DATA_SOURCE_VALUES)[number] | null => {
    if (v == null) return null;
    const normalised = String(v).trim().toLowerCase();
    if ((DATA_SOURCE_VALUES as readonly string[]).includes(normalised)) {
      return normalised as (typeof DATA_SOURCE_VALUES)[number];
    }
    return null;
  });

// ---------------------------------------------------------------------------
// Row schema
// ---------------------------------------------------------------------------

/**
 * Schema for a single AI-extracted CRM row (including the skip hint fields).
 * All fields are validated and normalised. Missing required keys default to null
 * rather than throwing — the schema is intentionally lenient on presence because
 * the AI might omit keys, but strict on value types/formats.
 */
export const AIExtractedRowSchema = z
  .object({
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
    // AI-provided skip hint — treated as untrusted; server enforces its own rule
    skip: z
      .union([z.boolean(), z.string(), z.null()])
      .optional()
      .transform((v): boolean => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') return v.toLowerCase() === 'true';
        return false;
      }),
    skipReason: nullableString,
  })
  .passthrough() // Don't fail on extra keys — just ignore them
  .transform((row) => {
    // Ensure all mandatory CRM keys are explicitly present, defaulting to null
    return {
      created_at: row.created_at ?? null,
      name: row.name ?? null,
      email: row.email ?? null,
      country_code: row.country_code ?? null,
      mobile_without_country_code: row.mobile_without_country_code ?? null,
      company: row.company ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      country: row.country ?? null,
      lead_owner: row.lead_owner ?? null,
      crm_status: row.crm_status ?? null,
      crm_note: row.crm_note ?? null,
      data_source: row.data_source ?? null,
      possession_time: row.possession_time ?? null,
      description: row.description ?? null,
      skip: row.skip ?? false,
      skipReason: row.skipReason ?? null,
    };
  });

export type ValidatedAIRow = z.output<typeof AIExtractedRowSchema>;

/**
 * Validates a single raw AI-output object.
 * Returns { success: true, data } or { success: false, error }.
 */
export function validateAIRow(raw: unknown): z.SafeParseReturnType<unknown, ValidatedAIRow> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    // Wrap in a fake error result
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
