import { getCrmSchema } from '../services/tools/crmSchema.tool';
import { retrieveMappingExamples } from '../services/tools/mappingExamples.tool';
import { validateMapping } from '../services/tools/validateMapping.tool';
import {
  executeBackendTool,
  ALLOWED_TOOL_NAMES,
  getRegisteredToolDeclarations,
} from '../services/tools/toolRegistry';
import { CRM_FIELDS, CRM_STATUS_VALUES, DATA_SOURCE_VALUES } from '../types';

describe('Tool 1: get_crm_schema', () => {
  it('returns the exact CRM field definitions synchronized with CRM_FIELDS', () => {
    const schema = getCrmSchema();

    expect(schema).toBeDefined();
    expect(schema.totalFields).toBe(CRM_FIELDS.length);
    expect(schema.totalFields).toBe(15);

    for (const field of CRM_FIELDS) {
      expect(schema.fields[field]).toBeDefined();
      expect(schema.fields[field].name).toBe(field);
      expect(typeof schema.fields[field].description).toBe('string');
      expect(typeof schema.fields[field].validationRules).toBe('string');
    }
  });

  it('correctly describes enums for crm_status and data_source', () => {
    const schema = getCrmSchema();

    expect(schema.fields.crm_status.acceptedEnumValues).toEqual(CRM_STATUS_VALUES);
    expect(schema.fields.data_source.acceptedEnumValues).toEqual(DATA_SOURCE_VALUES);
  });

  it('is read-only and contains no user or database state', () => {
    const schema1 = getCrmSchema();
    const schema2 = getCrmSchema();
    expect(schema1).toEqual(schema2);
  });
});

describe('Tool 2: retrieve_mapping_examples', () => {
  it('returns relevant, bounded examples for recognized messy headers', () => {
    const result = retrieveMappingExamples({
      headers: ['Cust_Name', 'Mob_No', 'Lead_Stage', 'Company Name'],
    });

    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.examples.length).toBeLessThanOrEqual(10);

    const nameMatch = result.examples.find((e) => e.targetField === 'name');
    expect(nameMatch).toBeDefined();
    expect(nameMatch?.sourceHeader).toBe('Cust_Name');

    const phoneMatch = result.examples.find(
      (e) => e.targetField === 'mobile_without_country_code'
    );
    expect(phoneMatch).toBeDefined();
    expect(phoneMatch?.sourceHeader).toBe('Mob_No');

    const statusMatch = result.examples.find((e) => e.targetField === 'crm_status');
    expect(statusMatch).toBeDefined();
    expect(statusMatch?.sourceHeader).toBe('Lead_Stage');
  });

  it('returns empty result when no trustworthy examples match', () => {
    const result = retrieveMappingExamples({
      headers: ['XyZ_Unknown_Col_999', 'Random_Foo_Bar_123'],
    });

    expect(result.totalMatches).toBe(0);
    expect(result.examples).toEqual([]);
  });

  it('handles empty or malformed inputs safely via Zod', () => {
    expect(retrieveMappingExamples({})).toEqual({ totalMatches: 0, examples: [] });
    expect(retrieveMappingExamples({ headers: [] })).toEqual({ totalMatches: 0, examples: [] });
    expect(retrieveMappingExamples(null)).toEqual({ totalMatches: 0, examples: [] });
    expect(retrieveMappingExamples({ headers: ['a'.repeat(300)] })).toEqual({
      totalMatches: 0,
      examples: [],
    });
  });

  it('bounds response size to at most 10 examples', () => {
    const manyHeaders = [
      'Cust_Name',
      'Contact',
      'Mob_No',
      'Phone',
      'Cell',
      'Email',
      'Emal',
      'Company Name',
      'Org',
      'City',
      'Town',
      'State',
      'Country',
      'Lead_Stage',
      'Status',
    ];

    const result = retrieveMappingExamples({ headers: manyHeaders });
    expect(result.examples.length).toBeLessThanOrEqual(10);
  });
});

describe('Tool 3: validate_mapping', () => {
  const sampleHeaders = ['Cust_Name', 'Mob_No', 'Email_Addr', 'Notes'];

  it('accepts valid mappings when target fields exist in CRM schema', () => {
    const result = validateMapping(
      {
        mappings: [
          { source: 'Cust_Name', target: 'name' },
          { source: 'Mob_No', target: 'mobile_without_country_code' },
          { source: 'Email_Addr', target: 'email' },
          { source: 'Notes', target: 'crm_note' },
        ],
      },
      { availableHeaders: sampleHeaders }
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.validatedMappings).toHaveLength(4);
  });

  it('rejects unknown target fields', () => {
    const result = validateMapping(
      {
        mappings: [
          { source: 'Cust_Name', target: 'phoneNumber' }, // Not in LeadSync schema!
          { source: 'Mob_No', target: 'fake_field_name' },
        ],
      },
      { availableHeaders: sampleHeaders }
    );

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors[0]).toContain('not a valid CRM field');
  });

  it('rejects source columns that are absent from the uploaded CSV', () => {
    const result = validateMapping(
      {
        mappings: [{ source: 'Non_Existent_Header', target: 'name' }],
      },
      { availableHeaders: sampleHeaders }
    );

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('does not exist in the uploaded CSV');
  });

  it('detects conflicting source-to-target mappings', () => {
    // Two columns mapped to the same single scalar target (name)
    const result1 = validateMapping(
      {
        mappings: [
          { source: 'Cust_Name', target: 'name' },
          { source: 'Notes', target: 'name' },
        ],
      },
      { availableHeaders: sampleHeaders }
    );

    expect(result1.valid).toBe(false);
    expect(result1.errors[0]).toContain('Multiple source columns');

    // One source column mapped to two different targets
    const result2 = validateMapping(
      {
        mappings: [
          { source: 'Cust_Name', target: 'name' },
          { source: 'Cust_Name', target: 'lead_owner' },
        ],
      },
      { availableHeaders: sampleHeaders }
    );

    expect(result2.valid).toBe(false);
    expect(result2.errors[0]).toContain('mapped to multiple targets');
  });

  it('allows multiple source columns mapped to crm_note as a catch-all', () => {
    const result = validateMapping(
      {
        mappings: [
          { source: 'Cust_Name', target: 'name' },
          { source: 'Mob_No', target: 'mobile_without_country_code' },
          { source: 'Email_Addr', target: 'crm_note' },
          { source: 'Notes', target: 'crm_note' },
        ],
      },
      { availableHeaders: sampleHeaders }
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('warns when neither email nor mobile is mapped', () => {
    const result = validateMapping(
      {
        mappings: [
          { source: 'Cust_Name', target: 'name' },
          { source: 'Notes', target: 'crm_note' },
        ],
      },
      { availableHeaders: sampleHeaders }
    );

    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Neither "email" nor "mobile_without_country_code"');
  });

  it('accepts explicit "unmapped" or "ignore" targets', () => {
    const result = validateMapping(
      {
        mappings: [
          { source: 'Cust_Name', target: 'name' },
          { source: 'Mob_No', target: 'mobile_without_country_code' },
          { source: 'Notes', target: 'unmapped' },
        ],
      },
      { availableHeaders: sampleHeaders }
    );

    expect(result.valid).toBe(true);
    expect(result.validatedMappings.find((m) => m.source === 'Notes')?.target).toBe('unmapped');
  });

  it('rejects invalid argument types via Zod validation', () => {
    const result = validateMapping({ invalidKey: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid tool arguments');
  });
});

describe('Tool Registry and Dispatcher', () => {
  it('exposes exactly the 3 authorized tools in allowlist', () => {
    expect(ALLOWED_TOOL_NAMES).toEqual([
      'get_crm_schema',
      'retrieve_mapping_examples',
      'validate_mapping',
    ]);
  });

  it('returns valid FunctionDeclarations for all 3 tools', () => {
    const declarations = getRegisteredToolDeclarations();
    expect(declarations).toHaveLength(3);
    const names = declarations.map((d) => d.name);
    expect(names).toContain('get_crm_schema');
    expect(names).toContain('retrieve_mapping_examples');
    expect(names).toContain('validate_mapping');
  });

  it('rejects execution of unauthorized function names', async () => {
    const result = await executeBackendTool(
      'unauthorized_system_cmd',
      {},
      { availableHeaders: [] }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unauthorized or unknown tool');
  });

  it('validates tool arguments on execution', async () => {
    const result = await executeBackendTool(
      'retrieve_mapping_examples',
      { badProp: true },
      { availableHeaders: [] }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid arguments for tool');
  });

  it('successfully executes get_crm_schema through the registry', async () => {
    const result = await executeBackendTool('get_crm_schema', {}, { availableHeaders: [] });
    expect(result.success).toBe(true);
    expect((result.data as { totalFields: number }).totalFields).toBe(15);
  });
});
