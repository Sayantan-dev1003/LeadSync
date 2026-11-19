import { FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { z } from 'zod';
import { CRM_FIELDS, CRMField } from '../../types';

export const SingleFieldMappingSchema = z.object({
  source: z.string().min(1).max(200),
  target: z.string().min(1).max(100),
});

export type SingleFieldMapping = z.infer<typeof SingleFieldMappingSchema>;

export const ValidateMappingArgsSchema = z.object({
  mappings: z.array(SingleFieldMappingSchema).min(1).max(50),
});

export type ValidateMappingArgs = z.infer<typeof ValidateMappingArgsSchema>;

export interface ValidateMappingResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  validatedMappings: Array<{ source: string; target: string }>;
}

export interface ValidationContext {
  availableHeaders?: string[];
}

/**
 * Valid targets allowed:
 * Any standard CRM field from CRM_FIELDS, or explicitly unmapped/ignored fields.
 */
const VALID_CRM_FIELDS_SET = new Set<string>(CRM_FIELDS);
const IGNORE_TARGETS_SET = new Set<string>(['ignore', 'unmapped', 'skip', 'null']);

/**
 * Tool 3 Implementation: validate_mapping
 * Validates proposed column mappings against the strict LeadSync CRM schema
 * and uploaded CSV header set.
 */
export function validateMapping(
  rawArgs: unknown,
  context?: ValidationContext
): ValidateMappingResult {
  const parsed = ValidateMappingArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    return {
      valid: false,
      errors: [`Invalid tool arguments: ${errorDetails}`],
      warnings: [],
      validatedMappings: [],
    };
  }

  const { mappings } = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const validatedMappings: Array<{ source: string; target: string }> = [];

  const sourceHeaderSet = context?.availableHeaders ? new Set(context.availableHeaders) : null;
  const targetToSources = new Map<string, string[]>();
  const sourceToTargets = new Map<string, string[]>();

  for (const mapping of mappings) {
    const trimmedSource = mapping.source.trim();
    const trimmedTarget = mapping.target.trim();

    // 1. Verify source column exists in uploaded CSV (if context available)
    if (sourceHeaderSet && !sourceHeaderSet.has(trimmedSource)) {
      errors.push(`Source column "${trimmedSource}" does not exist in the uploaded CSV.`);
      continue;
    }

    // 2. Target validation
    const lowerTarget = trimmedTarget.toLowerCase();
    if (IGNORE_TARGETS_SET.has(lowerTarget)) {
      // Intentionally ignored source column
      validatedMappings.push({ source: trimmedSource, target: 'unmapped' });
      continue;
    }

    if (!VALID_CRM_FIELDS_SET.has(trimmedTarget)) {
      errors.push(
        `Target field "${trimmedTarget}" is not a valid CRM field. Supported fields: ${Array.from(VALID_CRM_FIELDS_SET).join(', ')}`
      );
      continue;
    }

    // Track for conflict detection
    const existingSources = targetToSources.get(trimmedTarget) || [];
    existingSources.push(trimmedSource);
    targetToSources.set(trimmedTarget, existingSources);

    const existingTargets = sourceToTargets.get(trimmedSource) || [];
    existingTargets.push(trimmedTarget);
    sourceToTargets.set(trimmedSource, existingTargets);

    validatedMappings.push({ source: trimmedSource, target: trimmedTarget });
  }

  // 3. Detect conflicting mappings
  // A source column mapped to multiple different targets
  for (const [source, targets] of sourceToTargets.entries()) {
    if (targets.length > 1) {
      errors.push(`Source column "${source}" is mapped to multiple targets: [${targets.join(', ')}].`);
    }
  }

  // Multiple source columns mapped to the same single scalar target (crm_note is allowed to receive multiple)
  for (const [target, sources] of targetToSources.entries()) {
    if (sources.length > 1 && target !== 'crm_note') {
      errors.push(
        `Conflicting mapping: Multiple source columns [${sources.join(', ')}] are mapped to the same target field "${target}". Only one source may map to "${target}".`
      );
    }
  }

  // 4. Validate contact coverage (warning if neither email nor phone/mobile target is mapped)
  const hasEmailTarget = targetToSources.has('email');
  const hasMobileTarget = targetToSources.has('mobile_without_country_code');
  if (!hasEmailTarget && !hasMobileTarget) {
    warnings.push(
      'Neither "email" nor "mobile_without_country_code" is mapped. Rows without contact info will be marked as skipped by the server.'
    );
  }

  const isValid = errors.length === 0;

  return {
    valid: isValid,
    errors,
    warnings,
    validatedMappings: isValid ? validatedMappings : [],
  };
}

/**
 * Gemini FunctionDeclaration for validate_mapping
 */
export const validateMappingDeclaration: FunctionDeclaration = {
  name: 'validate_mapping',
  description: 'Validate proposed source-to-target field mappings against the LeadSync CRM schema and uploaded CSV headers. Validates that target fields exist, source headers are present in the CSV, and checks for conflicting mappings.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      mappings: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            source: {
              type: SchemaType.STRING,
              description: 'Exact source CSV column header name.',
            },
            target: {
              type: SchemaType.STRING,
              description: 'Target LeadSync CRM field name (e.g. "name", "email", "mobile_without_country_code", "crm_status", "crm_note", etc.) or "unmapped".',
            },
          },
          required: ['source', 'target'],
        },
        description: 'Array of proposed column mappings from source header to CRM field.',
      },
    },
    required: ['mappings'],
  },
};
