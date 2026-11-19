import { FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { z } from 'zod';
import { CRMField, CRM_FIELDS } from '../../types';

export const RetrieveMappingExamplesArgsSchema = z.object({
  headers: z.array(z.string().min(1).max(200)).min(1).max(50),
});

export type RetrieveMappingExamplesArgs = z.infer<typeof RetrieveMappingExamplesArgsSchema>;

export interface MappingExample {
  sourceHeader: string;
  matchedAlias: string;
  targetField: CRMField;
  confidence: 'high' | 'medium';
  reasoning: string;
}

export interface RetrieveMappingExamplesResult {
  totalMatches: number;
  examples: MappingExample[];
}

/**
 * Curated knowledge base of common source-column aliases for LeadSync CRM fields.
 * Derived strictly from real real-estate and lead-gen exports (Google Ads, Facebook Leads, manual spreadsheets).
 */
interface KnowledgeEntry {
  targetField: CRMField;
  aliases: string[];
  reasoning: string;
}

const CURATED_KNOWLEDGE_BASE: KnowledgeEntry[] = [
  {
    targetField: 'name',
    aliases: [
      'full name',
      'contact name',
      'lead name',
      'customer name',
      'client name',
      'lead (person)',
      'person',
      'lead',
      'contact',
      'first name',
      'buyer name',
      'cust name',
      'cust_name',
    ],
    reasoning: 'Represents the primary name of the lead or prospect.',
  },
  {
    targetField: 'email',
    aliases: [
      'email',
      'email address',
      'contact email',
      'e-mail',
      'email id',
      'customer email',
      'primary email',
      'emal',
      'mail',
    ],
    reasoning: 'Primary email address for communication and lead deduplication.',
  },
  {
    targetField: 'country_code',
    aliases: [
      'country code',
      'isd code',
      'dial code',
      'phone code',
      'isd',
      'prefix',
    ],
    reasoning: 'Phone country dialing code with + prefix (e.g. +91, +1).',
  },
  {
    targetField: 'mobile_without_country_code',
    aliases: [
      'mobile',
      'mob no',
      'mob_no',
      'phone',
      'phone number',
      'contact number',
      'cell',
      'mobile number',
      'telephone',
      'whatsapp',
      'contact no',
      'ph no',
      'phone no',
      'cell phone',
      'mobile no.',
    ],
    reasoning: 'Primary subscriber telephone or mobile number without country code.',
  },
  {
    targetField: 'company',
    aliases: [
      'company name',
      'company',
      'organization',
      'organization name',
      'org',
      'agency',
      'business',
      'firm',
      'employer',
    ],
    reasoning: 'Company, business, or organization affiliated with the lead.',
  },
  {
    targetField: 'city',
    aliases: [
      'city',
      'town',
      'metro',
      'location (city)',
      'city name',
    ],
    reasoning: 'City location of the lead or property search.',
  },
  {
    targetField: 'state',
    aliases: [
      'state',
      'province',
      'region',
      'state/province',
    ],
    reasoning: 'State or administrative region.',
  },
  {
    targetField: 'country',
    aliases: [
      'country',
      'nation',
      'country name',
    ],
    reasoning: 'Country of residence or origin.',
  },
  {
    targetField: 'lead_owner',
    aliases: [
      'person incharge',
      'person in-charge',
      'assigned agent',
      'agent',
      'owner',
      'sales rep',
      'lead owner',
      'incharge',
      'assigned to',
      'representative',
    ],
    reasoning: 'Sales representative or team member handling the lead.',
  },
  {
    targetField: 'crm_status',
    aliases: [
      'staus',
      'status',
      'lead stage',
      'lead_stage',
      'lead status',
      'disposition',
      'call status',
      'stage',
      'stage name',
    ],
    reasoning: 'Qualification status. Must map to one of: GOOD_LEAD_FOLLOW_UP, DID_NOT_CONNECT, BAD_LEAD, SALE_DONE.',
  },
  {
    targetField: 'crm_note',
    aliases: [
      'follow up notes',
      'follow-up notes',
      'remarks',
      'comments',
      'notes',
      'feedback',
      'discussion',
      'conversation',
      'agent notes',
      'call notes',
      'additional info',
    ],
    reasoning: 'Freeform notes, follow-up conversation logs, or secondary contact details.',
  },
  {
    targetField: 'data_source',
    aliases: [
      'data source',
      'lead source',
      'campaign source',
      'source',
      'platform',
      'channel',
      'acquisition channel',
    ],
    reasoning: 'Acquisition source. Only set if matching: leads_on_demand, meridian_tower, eden_park, varah_swamy, sarjapur_plots.',
  },
  {
    targetField: 'created_at',
    aliases: [
      'date added',
      'creation date',
      'date',
      'lead date',
      'timestamp',
      'created on',
      'created at',
      'submission time',
      'registered date',
    ],
    reasoning: 'Timestamp of lead acquisition, normalized to ISO 8601.',
  },
  {
    targetField: 'possession_time',
    aliases: [
      'possession',
      'possession time',
      'possession timeline',
      'move-in date',
      'handover',
      'completion date',
    ],
    reasoning: 'Expected timeline for property handover or move-in.',
  },
  {
    targetField: 'description',
    aliases: [
      'description',
      'requirement',
      'property details',
      'query',
      'project interested',
      'inquiry',
      'budget & requirement',
    ],
    reasoning: 'General client requirements or property preferences.',
  },
];

/**
 * Normalizes header string for comparison:
 * Lowercases, strips punctuation, normalizes whitespace.
 */
function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_\-/.()\\\[\]#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tool 2 Implementation: retrieve_mapping_examples
 * Deterministically finds matching alias examples for candidate headers.
 * Bounded output (maximum 10 matches total).
 */
export function retrieveMappingExamples(rawArgs: unknown): RetrieveMappingExamplesResult {
  const parsed = RetrieveMappingExamplesArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return { totalMatches: 0, examples: [] };
  }

  const { headers } = parsed.data;
  const matches: MappingExample[] = [];
  const seenTargets = new Set<string>();

  for (const rawHeader of headers) {
    const normalized = normalizeHeader(rawHeader);
    if (!normalized) continue;

    let bestMatch: MappingExample | null = null;

    for (const entry of CURATED_KNOWLEDGE_BASE) {
      for (const alias of entry.aliases) {
        const normalizedAlias = normalizeHeader(alias);

        // Exact match
        if (normalized === normalizedAlias) {
          bestMatch = {
            sourceHeader: rawHeader,
            matchedAlias: alias,
            targetField: entry.targetField,
            confidence: 'high',
            reasoning: entry.reasoning,
          };
          break;
        }

        // Substring / token boundary match (high confidence if words match)
        if (
          normalized.includes(normalizedAlias) ||
          normalizedAlias.includes(normalized)
        ) {
          if (!bestMatch || bestMatch.confidence !== 'high') {
            bestMatch = {
              sourceHeader: rawHeader,
              matchedAlias: alias,
              targetField: entry.targetField,
              confidence: 'medium',
              reasoning: entry.reasoning,
            };
          }
        }
      }

      if (bestMatch?.confidence === 'high') break;
    }

    if (bestMatch && !seenTargets.has(`${bestMatch.sourceHeader}->${bestMatch.targetField}`)) {
      seenTargets.add(`${bestMatch.sourceHeader}->${bestMatch.targetField}`);
      matches.push(bestMatch);
      // Bound response size to at most 10 examples
      if (matches.length >= 10) break;
    }
  }

  return {
    totalMatches: matches.length,
    examples: matches,
  };
}

/**
 * Gemini FunctionDeclaration for retrieve_mapping_examples
 */
export const retrieveMappingExamplesDeclaration: FunctionDeclaration = {
  name: 'retrieve_mapping_examples',
  description: 'Retrieve curated mapping examples and known real-world column aliases for given CSV header names. Call this tool when source column names are abbreviated, misspelled, or non-standard.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      headers: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
        description: 'Array of source CSV column headers to look up mapping examples for.',
      },
    },
    required: ['headers'],
  },
};
