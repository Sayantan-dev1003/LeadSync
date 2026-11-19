import { FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { CRM_FIELDS, CRM_STATUS_VALUES, DATA_SOURCE_VALUES } from '../../types';

export interface CRMFieldDefinition {
  name: string;
  type: 'string' | 'enum' | 'date' | 'phone';
  nullable: boolean;
  required: boolean;
  acceptedEnumValues?: readonly string[];
  validationRules: string;
  description: string;
}

export interface CRMSchemaDescription {
  version: string;
  totalFields: number;
  fields: Record<string, CRMFieldDefinition>;
  notes: string[];
}

/**
 * Synchronized with CRM_FIELDS, CRM_STATUS_VALUES, and DATA_SOURCE_VALUES.
 * Prevents contract drift with zodSchemas.service.ts and Prisma schema.
 */
export const CRM_SCHEMA_DEFINITIONS: Record<string, CRMFieldDefinition> = {
  created_at: {
    name: 'created_at',
    type: 'date',
    nullable: true,
    required: false,
    validationRules: 'ISO 8601 string ONLY (e.g. "2024-05-13T14:20:00.000Z") or null. Unparseable dates become null.',
    description: 'Date and time of lead creation. Normalize any source date format to ISO 8601 UTC.',
  },
  name: {
    name: 'name',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Trimmed string or null. Concatenate first and last names if separate.',
    description: 'Full name of the contact or lead.',
  },
  email: {
    name: 'email',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Valid email address format (e.g. user@domain.com) or null. Lowercase normalized.',
    description: 'Primary email address only. Additional emails must be preserved in crm_note.',
  },
  country_code: {
    name: 'country_code',
    type: 'phone',
    nullable: true,
    required: false,
    validationRules: 'Must start with + followed by 1 to 4 digits (e.g. "+91", "+1", "+44") or null.',
    description: 'International dialing country code split from combined phone number.',
  },
  mobile_without_country_code: {
    name: 'mobile_without_country_code',
    type: 'phone',
    nullable: true,
    required: false,
    validationRules: 'Digits only, 5 to 15 digits (ITU-T E.164 range), or null.',
    description: 'Subscriber mobile number without country code or formatting symbols.',
  },
  company: {
    name: 'company',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Trimmed string or null.',
    description: 'Company, organization, business, or employer name.',
  },
  city: {
    name: 'city',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Trimmed string or null.',
    description: 'City or town of residence/interest.',
  },
  state: {
    name: 'state',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Trimmed string or null.',
    description: 'State, province, or region.',
  },
  country: {
    name: 'country',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Trimmed string or null.',
    description: 'Country name.',
  },
  lead_owner: {
    name: 'lead_owner',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Trimmed string or null.',
    description: 'Person or agent responsible for this lead.',
  },
  crm_status: {
    name: 'crm_status',
    type: 'enum',
    nullable: true,
    required: false,
    acceptedEnumValues: CRM_STATUS_VALUES,
    validationRules: `Must strictly match one of: ${CRM_STATUS_VALUES.join(', ')} or null.`,
    description: 'Lead qualification status. GOOD_LEAD_FOLLOW_UP (interested), DID_NOT_CONNECT (unreachable), BAD_LEAD (junk/not interested), SALE_DONE (converted/closed).',
  },
  crm_note: {
    name: 'crm_note',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'String or null. Use literal \\n for newlines, concatenate multiple remarks with " | ".',
    description: 'Catch-all for follow-up notes, secondary emails, secondary phone numbers, and unmapped valuable context.',
  },
  data_source: {
    name: 'data_source',
    type: 'enum',
    nullable: true,
    required: false,
    acceptedEnumValues: DATA_SOURCE_VALUES,
    validationRules: `Must strictly match one of: ${DATA_SOURCE_VALUES.join(', ')} or null. Never guess.`,
    description: 'Marketing campaign or acquisition channel origin.',
  },
  possession_time: {
    name: 'possession_time',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Trimmed string or null (e.g. "Ready to move", "Dec 2026").',
    description: 'Real estate possession or handover timeline.',
  },
  description: {
    name: 'description',
    type: 'string',
    nullable: true,
    required: false,
    validationRules: 'Trimmed string or null.',
    description: 'General description, client inquiries, or requirement details.',
  },
};

/**
 * Tool 1 Implementation: get_crm_schema
 * Read-only, deterministic representation of LeadSync target schema.
 */
export function getCrmSchema(): CRMSchemaDescription {
  return {
    version: '1.0.0',
    totalFields: CRM_FIELDS.length,
    fields: CRM_SCHEMA_DEFINITIONS,
    notes: [
      'Rows with neither email nor mobile_without_country_code will be marked as skipped by the server.',
      'Always map combined phone numbers to country_code and mobile_without_country_code.',
      'Never invent custom target fields not listed in this schema.',
      'Unmapped informative source columns should be folded into crm_note.',
    ],
  };
}

/**
 * Gemini FunctionDeclaration for get_crm_schema
 */
export const getCrmSchemaDeclaration: FunctionDeclaration = {
  name: 'get_crm_schema',
  description: 'Inspect the official LeadSync CRM schema, including supported target fields, expected data types, accepted enum values, and validation constraints. Call this tool when analyzing CSV headers to verify valid target fields.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {},
  },
};
