# LeadSync – Agent Reliability Evaluation Framework

## Overview
The Agent Reliability Evaluation Framework provides systematic, quantitative assessment of LeadSync's Gemini function-calling and CRM extraction workflow. Rather than relying solely on conventional unit tests, the framework subjects the agentic pipeline to a suite of 26 deterministic scenarios and calculates formal reliability metrics.

---

## Evaluation Architecture

```text
scenarios.ts (26 Scenarios)
     │
     ▼
evaluator.ts ─── executes against ───► Gemini Tool Orchestrator / Backend Tools / Zod Validation
     │
     ▼
evaluation-metrics.ts ─── computes ───► 4 Core Reliability Metrics + Aggregate Report
     │
     ▼
runEvaluation.ts (CLI) / agent-evaluation.test.ts (Jest CI)
```

---

## Scenario Taxonomy (26 Scenarios across 4 Categories)

### A. Function / Tool Selection Accuracy (6 Scenarios)
- `SCN-SEL-01`: Straightforward recognizable CRM headers (`name`, `email`, `mobile_without_country_code`, `crm_status`).
- `SCN-SEL-02`: Inconsistent and unfamiliar column names (`Cust_Name`, `Mob_No`, `Emal`, `staus`).
- `SCN-SEL-03`: Reordered columns layout (`crm_status`, `crm_note`, `email`, `company`, `name`).
- `SCN-SEL-04`: Synonymous and alternative column names (`Lead (person)`, `Cell Phone`, `Organization`, `Town`).
- `SCN-SEL-05`: Ambiguous headers requiring schema inspection (`Location`, `Incharge`, `Discussion`).
- `SCN-SEL-06`: Columns that should not map to any CRM field (`Internal_Tracking_Hash`, `Cookie_ID`).

### B. Function Argument Accuracy (6 Scenarios)
- `SCN-ARG-01`: Correctly structured function arguments conforming to strict Zod schema.
- `SCN-ARG-02`: Missing mandatory argument property (`headers` missing from `retrieve_mapping_examples`).
- `SCN-ARG-03`: Incorrect argument type provided by model (`headers` as a string instead of string array).
- `SCN-ARG-04`: Invalid CRM target field name in mapping argument (`telephoneNumber` rejected).
- `SCN-ARG-05`: Unexpected additional arguments (Strict schema rejects injected keys).
- `SCN-ARG-06`: Empty or malformed argument values (Empty string rejection via `min(1)`).

### C. AI Output Validation (6 Scenarios)
- `SCN-VAL-01`: Valid structured AI extraction response (Full 17-field contract).
- `SCN-VAL-02`: Malformed JSON payload from model (Truncated response handling).
- `SCN-VAL-03`: Missing contact info (Authoritative server skip override).
- `SCN-VAL-04`: Invalid email address format in output (Rejection with diagnostics).
- `SCN-VAL-05`: Invalid mobile phone number format (<5 digits rejected).
- `SCN-VAL-06`: Unexpected additional fields in AI response (Strict schema rejects rogue keys).

### D. Tool Execution and Recovery (8 Scenarios)
- `SCN-REC-01`: Successful function execution (`get_crm_schema`).
- `SCN-REC-02`: Transient tool failure followed by successful backoff recovery.
- `SCN-REC-03`: Permanent tool execution failure (Sanitized failure response).
- `SCN-REC-04`: Tool execution timeout enforcement (`TOOL_TIMEOUT`).
- `SCN-REC-05`: Unknown function name rejected by allowlist (`UNKNOWN_TOOL`).
- `SCN-REC-06`: Maximum orchestration rounds and tool-call limit reached (`TOOL_CALL_LIMIT_EXCEEDED`).
- `SCN-REC-07`: Unauthorized caller or ownership mismatch (`UNAUTHORIZED_TOOL_EXECUTION`).
- `SCN-REC-08`: Human approval boundary enforcement (Zero production CRM mutation before `/approve`).

---

## Measurable Evaluation Metrics & Formulas

### Metric 1: Successful Extraction Rate
Measures the proportion of valid expected extraction cases that complete extraction and pass all applicable validation requirements.
$$\text{Successful Extraction Rate} = \left(\frac{\text{Successfully Extracted Expected Cases}}{\text{Total Eligible Evaluation Cases}}\right) \times 100$$
The evaluation report additionally reports:
- **CSV Success Rate**: Percentage of full CSV scenarios processed without failure.
- **Individual Row Extraction Rate**: Percentage of individual candidate rows converted to valid CRM records.

### Metric 2: Function-Call Accuracy
- **Function Selection Accuracy**:
  $$\text{Selection Accuracy} = \left(\frac{\text{Correct Tool Selections}}{\text{Total Tool Selection Scenarios}}\right) \times 100$$
- **Function Argument Accuracy**:
  $$\text{Argument Accuracy} = \left(\frac{\text{Correct Argument Fields}}{\text{Total Evaluated Argument Fields}}\right) \times 100$$

### Metric 3: Schema Validation Pass Rate
Measures whether the Zod validation layer correctly accepts valid outputs AND rejects invalid outputs:
$$\text{Schema Validation Pass Rate} = \left(\frac{\text{Valid Accepted} + \text{Invalid Rejected}}{\text{Total Schema Validation Test Cases}}\right) \times 100$$

### Metric 4: Failure Recovery Rate
Measures resilience against transient tool errors:
$$\text{Failure Recovery Rate} = \left(\frac{\text{Successfully Recovered Transient Failures}}{\text{Total Eligible Transient Failure Scenarios}}\right) \times 100$$
*Permanent failures are strictly excluded from the recovery numerator.*

---

## Execution Commands

### 1. Deterministic CI Mode (Fast, zero API costs, deterministic)
```bash
cd backend
npm run evaluate:agent
```

### 2. Live Gemini Evaluation Mode (Requires `GEMINI_API_KEY`)
```bash
cd backend
npm run evaluate:agent:live
```
