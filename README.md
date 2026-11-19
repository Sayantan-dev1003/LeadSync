# LeadSync (GrowEasy) — AI-Assisted Human-in-the-Loop CRM CSV Importer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-TypeScript-white)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-blue)](https://prisma.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue)](https://docker.com/)

An enterprise-grade, human-in-the-loop AI-assisted CSV import workflow designed for the CRM ecosystem. By leveraging Google's Gemini AI, the system maps inconsistent, schema-less CSV dumps (e.g. Facebook Leads, Google Ads, real-estate CRM exports, and messy manual spreadsheets) into a strictly validated CRM schema.

**Core Principle:** Extracted leads are **never** written directly into CRM production tables during AI extraction. All extractions are staged in a database-backed pending import record, strictly validated, and presented to a human reviewer. **Only explicitly approved data is committed to PostgreSQL in an atomic transaction.**

---

## 🏗️ System Architecture & Workflow

```text
CSV Upload ➔ Gemini AI Extraction ➔ Strict Zod Validation ➔ Staging (pending_imports)
                                                                       │
                                        ┌──────────────────────────────┴──────────────────────────────┐
                                        ▼                                                             ▼
                               [Human Approval]                                              [Human Rejection]
                                        │                                                             │
                         Atomic Conditional Claim (PENDING)                            Atomic Conditional Claim (PENDING)
                                        │                                                             │
                        Server Revalidation + Transaction                             Purge Staged Records (PII)
                                        │                                                             │
                                        ▼                                                             ▼
                             imports & leads tables                                         0 CRM Records Written
```

### Component Architecture

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                Frontend (Next.js 16)                                   │
│                                                                                        │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐  │
│  │ 1. Upload    │ ➔ │ 2. Preview   │ ➔ │ 3. SSE Stream   │ ➔ │ 4. Review AI Results │  │
│  │ (Dropzone)   │   │ (PapaParse)  │   │ Extraction View │   │ (Virtual Table +     │  │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │  Expandable Details) │  │
│                                                              └──────────┬───────────┘  │
│                                                                         │              │
│                                           ┌─────────────────────────────┴──────────┐   │
│                                           ▼                                        ▼   │
│                                  [Approve & Import]                        [Reject Import] │
│                                  (Double-Click Safe)                               │   │
│                                           │                                        │   │
│                                           ▼                                        ▼   │
│                                 Manage Leads View                      Zero CRM Leads Created  │
└───────────────────────────────────────────┬────────────────────────────────────────┬───┘
               POST /api/extract (Phase A)  │                                        │
                         SSE Stream ◂───────┤                                        │
                                            ▼                                        │
┌────────────────────────────────────────────────────────────────────────────────────┼───┐
│                           Backend (Express + TypeScript)                           │   │
│                                                                                    │   │
│  ┌───────────────────────┐   ┌──────────────────────────────────────────────┐   ┌──┴────────────────┐  │
│  │ Phase A: Extract      │ ➔ │ Import Orchestrator                          │ ➔ │ Database Staging  │  │
│  │ (multer + csv-parse)  │   │ 1. Stage A: Tool Orchestrator (Function Call)│   │ (pending_imports) │  │
│  │                       │   │ 2. Stage B: Batch Extractor + Backoff Retry  │   │                   │  │
│  └───────────────────────┘   └──────────────────────────────────────────────┘   └───────────────────┘  │
│                                                                                    │   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │   │
│  │ Phase B: POST /api/imports/:id/approve (Protected by Single-Owner Session)   │  │   │
│  │   1. Atomic conditional update: status: 'PENDING' -> 'APPROVED'              │  │   │
│  │   2. Server-side strict Zod revalidation                                     │  │   │
│  │   3. Atomic transaction (Prisma $transaction):                               │  │   │
│  │      - Create Import record                                                  │  │   │
│  │      - Create Lead records                                                   │  │   │
│  │      - Create SkippedRow records                                             │  │   │
│  │      - Mark pending import COMMITTED & purge staged PII JSON                 │  │   │
│  │   4. Idempotent return for repeated approval requests                        │  │   │
│  └──────────────────────────────────────────────────────────────────────────────┘  │   │
│                                                                                    │   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │   │
│  │ Phase C: POST /api/imports/:id/reject (Protected by Single-Owner Session)    │  │   │
│  │   1. Atomic conditional update: status: 'PENDING' -> 'REJECTED'              │◀─┘   │
│  │   2. Purge staged records, skipped, and failed JSON (PII defense)            │      │
│  │   3. Idempotent return for duplicate rejection requests                      │      │
│  └──────────────────────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────┬──────────────────────────────────────────┘
                                              │
┌─────────────────────────────────────────────▼──────────────────────────────────────────┐
│                             PostgreSQL (via Prisma ORM)                                │
│   pending_imports (Staging) ➔ imports table ➔ leads table ➔ skipped_rows table         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 State Machine Specification

Pending imports follow a strict, non-reversible state machine:

| State | Description | Transitions To | Permitted Operations |
|---|---|---|---|
| `PENDING` | Newly extracted and staged import waiting for human review. | `APPROVED`, `REJECTED`, `EXPIRED` | Review (`GET`), Approve (`POST`), Reject (`POST`) |
| `APPROVED` | Atomically claimed by approval handler during transaction processing. | `COMMITTED` (or rolled back to `PENDING` on DB error) | Read-only |
| `COMMITTED` | Successfully persisted into final `imports`, `leads`, and `skipped_rows` tables. | *Terminal* | Idempotent duplicate approval return |
| `REJECTED` | Explicitly rejected by human reviewer. Staged PII purged immediately. | *Terminal* | Idempotent duplicate rejection return |
| `EXPIRED` | Time-to-live (TTL) exceeded (default 24h). Cannot be approved or committed. | *Terminal* | Read-only, Scheduled cleanup |

### Concurrency & Race-Condition Guarantees
- **Atomic Conditional Updates**: Both approval and rejection execute database-backed conditional updates: `prisma.pendingImport.updateMany({ where: { id, status: 'PENDING' }, data: { status: '...' } })`.
- **Mutual Exclusivity**: If approval and rejection requests arrive simultaneously, exactly one can transition the status from `PENDING`. The other receives a `count: 0` result and is rejected with an HTTP `400` conflict error.
- **Transactional Rollback**: If database persistence fails during approval, the entire Prisma transaction rolls back and the pending import is reset to `PENDING`, preventing corrupt or orphaned records.
- **Idempotency**: Repeated approval requests on an already approved/committed import return the existing completed import metadata with HTTP `200` without creating duplicate records.

---

## 🛡️ Strict AI-Output Validation & Data Integrity

The application implements defense-in-depth data validation using Zod:

1. **Strict Zod Schemas (`.strict()`)**: Unexpected fields returned by the AI are rejected.
2. **Mandatory Field Requirements**:
   - `name`: String, minimum 1 character. Required.
   - `email`: Valid email format or explicit `null`.
   - `country_code`: Valid format (`+` followed by 1-4 digits) or explicit `null`.
   - `mobile`: 5-15 digits or explicit `null`.
   - `crm_status`: Valid enum value (`GOOD_LEAD_FOLLOW_UP`, `DID_NOT_CONNECT`, `BAD_LEAD`, `SALE_DONE`) or explicit `null`.
   - `data_source`: Valid enum value (`leads_on_demand`, `meridian_tower`, `eden_park`, `varah_swamy`, `sarjapur_plots`) or explicit `null`.
3. **No Silent Coercion**: Malformed non-null values (e.g. `"not-an-email"`, `"invalid-date"`, `"bad-status"`) are **not** silently converted to `null`. They are rejected as validation errors, placing the affected row in the `failed` category with specific failure reasons.
4. **Deterministic Server-Side Skip Rules**: The AI's `skip` flag is treated as an advisory hint only. The server deterministically classifies rows:
   - A row is **skipped** if and only if both `email` and `mobile` are empty or null.
   - A row is **failed** if the AI batch failed or schema validation failed.
   - Valid rows with contact data are never discarded due to model hallucination.
5. **Row Correspondence & Count Invariance**: Input row count must equal the sum of extracted, skipped, and failed records: `inputCount == validCount + skippedCount + failedCount`. Missing rows are detected and flagged.

---

## 🔒 Privacy, Security & Data Retention

### PII Redaction & Defensive Logging
- **Log Sanitizer (`backend/src/lib/sanitizer.ts`)**: Error logs, warning messages, and SSE payloads pass through sanitizers that strip emails, phone numbers, Gemini API keys, Bearer tokens, and database credentials.
- **Safe Error Codes**: Raw CSV row dumps and model prompt excerpts are removed from public API errors.

### Data Retention & Staged PII Purge
- **Immediate Purge on Commitment**: Upon successful human approval and database persistence, staged `records`, `skipped`, and `failed` JSON columns in `pending_imports` are set to `[]`.
- **Immediate Purge on Rejection**: Rejecting an import immediately purges staged `records`, `skipped`, and `failed` JSON arrays.
- **24-Hour TTL**: Pending imports automatically expire after 24 hours (`expiresAt = now + 24h`). Expired imports cannot be approved.
- **Automated Retention Cleanup**: `cleanupExpiredPendingImports()` service and `POST /api/imports/cleanup` endpoint periodically purge staged PII for expired imports and delete stale pending imports older than 7 days. Completed CRM records in `leads` are never touched by cleanup.

### Single-Owner Google OAuth Authentication & Authorization
LeadSync is architected as a single-owner portfolio application with strict owner-only authorization and a clean, empty public read-only mode.

- **Google OAuth 2.0 / OpenID Connect**: Uses Google's official authorization code flow with:
  - **PKCE (`code_verifier` / `code_challenge: S256`)** for authorization code security.
  - **Exact Nonce Verification**: Nonces generated during login initiation are cryptographically validated against the returned Google ID token.
  - **Durable OAuth State Store**: State, nonce, and PKCE verifier are stored in signed `HttpOnly` cookies (`leadsync_oauth_state`) and backed by the PostgreSQL `OAuthState` model, persisting seamlessly across server restarts or load balancers.
  - Required Scopes: `openid email profile`.
- **Single-Owner Identity Pinning**:
  - `OWNER_GOOGLE_EMAIL`: The allowlisted owner email address (case-insensitive).
  - `OWNER_GOOGLE_SUB` (Optional): Google subject identifier for cryptographic identity pinning.
  - Any unauthorized Google account is strictly rejected with HTTP `403` and redirected to an unauthorized error state without creating a session.
- **Server-Side Session Management**:
  - Sessions are managed server-side via PostgreSQL (`Session` model) using cryptographically random 256-bit opaque tokens.
  - Sessions are transmitted exclusively via `HttpOnly`, `SameSite=Lax`, `Secure` (in production) cookies (`leadsync_session`).
  - No session secrets or JWTs are stored in `localStorage` or exposed in client-side code.
- **Empty Public Read-Only Mode**:
  - Unauthenticated visitors can browse the portfolio UI, view empty statistics (zero leads/imports), and observe the human-in-the-loop workflow.
  - **Zero Synthetic Records**: No mock, seeded, or synthetic CRM records are displayed publicly.
  - CSV upload, Gemini AI extraction, pending review, approval/rejection, and lead modifications strictly require the verified owner session.
- **CSRF Protection**:
  - State-changing requests (`POST`, `PUT`, `DELETE`) are verified against allowed frontend origins (`APP_ORIGIN`, `FRONTEND_URL`, localhost).

---

## 🖥️ Frontend UX & Human Review Screen

- **Navbar Google Sign-In**: Unauthenticated visitors see a standard "Sign in with Google" button. Authenticated owners see their Google profile avatar, display name, and a sign-out dropdown.
- **SSE Stream Integrity**: `CSVImporter.tsx` verifies receipt of a valid `pendingImportId` before transitioning to the review step. Malformed or failed extractions show a recoverable error alert instead of a blank review screen.
- **No Premature Navigation**: Navigation to `/manage-leads` occurs **only** after human approval is confirmed by the backend database transaction.
- **Double-Click Protection**: Approval and rejection buttons disable immediately with loading states to prevent race conditions or repeated submissions.
- **Complete CRM Field Exposure (`ReviewStep.tsx`)**:
  - Core fields displayed in the virtual table: Name, Contact Info (Email, Phone, Country Code), Status pill, Source badge.
  - **Expandable Row Details**: Click the chevron or press `Enter`/`Space` to expand detailed fields: Location (City, State, Country), Possession Timeline, Lead Owner, CRM Notes, and Description.
  - **Virtualized Performance**: Maintained via `@tanstack/react-virtual` with dynamic row measurement, ensuring 60fps scrolling over thousands of rows.

---

## 📡 API Reference

### Authentication Endpoints

#### 1. `GET /api/auth/google`
Initiates Google OAuth 2.0 flow with PKCE code challenge and durable signed state/nonce.
- **Response**: `302 Redirect` to Google Accounts login.

#### 2. `GET /api/auth/google/callback`
Validates OAuth authorization code, verifies PKCE code verifier and exact nonce, inspects ID token signature, enforces single-owner allowlist, and sets `leadsync_session` cookie.
- **Response**: `302 Redirect` to frontend (or error redirect with `?auth_error=unauthorized`).

#### 3. `GET /api/auth/me`
Returns authenticated owner session status.
- **Response**: `200 OK` with `{ authenticated: true, user: { email, name, picture } }` or `{ authenticated: false, user: null }`.

#### 4. `POST /api/auth/logout`
Revokes active session in PostgreSQL and clears cookies.
- **Response**: `200 OK` with `{ success: true }`.

### Protected CRM Endpoints (Owner-Only)

#### 5. `POST /api/extract`
Uploads a CSV file and streams AI extraction results via Server-Sent Events (SSE).
- **Cookie**: `leadsync_session`
- **Body**: `file`: CSV file (multipart/form-data)
- **SSE Events**:
  - `progress`: `{ type: 'progress', batchIndex, totalBatches, batchRecords, batchSkipped, batchFailed }`
  - `complete`: `{ type: 'complete', pendingImportId, totalValid, totalSkipped, totalFailed }`
  - `error`: `{ type: 'error', message }`

#### 6. `GET /api/imports/pending/:id`
Retrieves a pending import by ID for review.
- **Cookie**: `leadsync_session`
- **Response**: `200 OK` with `PendingImportDTO`

#### 7. `POST /api/imports/:id/approve`
Approves and commits a pending import into PostgreSQL tables (`imports`, `leads`, `skipped_rows`).
- **Cookie**: `leadsync_session`
- **Response**: `200 OK` with `{ message, importId, totalImported, totalSkipped }`

#### 8. `POST /api/imports/:id/reject`
Rejects a pending import and purges staged PII.
- **Cookie**: `leadsync_session`
- **Response**: `200 OK` with `{ message, pendingImportId, status: 'REJECTED' }`

#### 9. `GET /api/leads`
Retrieves CRM leads with search, pagination, and sorting.
- **Cookie**: `leadsync_session`
- **Response**: `200 OK` with `{ leads, total, page, pageSize }`

#### 10. `POST /api/imports/cleanup`
Maintenance endpoint to clean up expired pending imports and purge staged PII.
- **Cookie**: `leadsync_session`
- **Response**: `200 OK` with `{ message, purgedCount, deletedCount }`

---

## 🗄️ Database Schema & Prisma Migrations

### Prisma Schema (`backend/prisma/schema.prisma`)
- `PendingImport`: Staging table with `status` (`PENDING`, `APPROVED`, `COMMITTED`, `REJECTED`, `EXPIRED`), `records` (JSON), `skipped` (JSON), `failed` (JSON), `userId`, `expiresAt`, `committedImportId`.
- `Import`: Completed import audit record with `userId`, `totalRows`, `importedRows`, `skippedRows`.
- `Lead`: Final CRM lead records.
- `SkippedRow`: Audit records for skipped rows with reason codes.

### Migration Commands
```bash
cd backend

# Create and apply new migrations in development
npx prisma migrate dev --name <migration_name>

# Apply committed migrations in production / CI
npx prisma migrate deploy

# Generate typed Prisma client
npx prisma generate
```

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- **Node.js 20+**
- **PostgreSQL** database (e.g. Neon, Supabase, or local Docker container)
- **Google AI Studio** Gemini API Key

### 1. Repository Setup
```bash
git clone https://github.com/Sayantan-dev1003/LeadSync
cd LeadSync
```

### 2. Backend Initialization
```bash
cd backend
cp .env.example .env
# Edit .env with your DATABASE_URL, GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and OWNER_GOOGLE_EMAIL
npm ci
npx prisma generate
npx prisma migrate deploy
npm run dev    # Starts API on http://localhost:4000
```

### 3. Frontend Initialization
```bash
cd ../frontend
cp .env.example .env.local
npm ci
npm run dev    # Starts Next.js app on http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🤖 Gemini Function Calling & Tool-Orchestrated CRM Extraction

LeadSync upgrades its AI mapping pipeline with genuine **Gemini Function Calling (Tool Use)**. Rather than relying solely on monolithic prompt engineering or simulated tool strings, Gemini dynamically requests backend tools, receives structured execution outputs, reasons over schema constraints, and validates proposed mappings before processing records.

### 1. Conceptual Distinction

| Technique | How LeadSync Uses It |
|---|---|
| **Prompt Engineering** | System instructions define the extraction rules, date normalization, and CRM domain context. |
| **Structured Output** | Used in Stage B where Gemini outputs a strict JSON array conforming to the 15 CRM target fields. |
| **Native Function Calling** | Model dynamically calls declared tools (`get_crm_schema`, `retrieve_mapping_examples`, `validate_mapping`), receives actual server tool responses, and reasons across multiple turns. |
| **Deterministic Alias Lookup** | Tool 2 searches a curated, bounded alias dictionary using token matching (no hallucinated mappings). |
| **Advanced RAG (Future)** | Vector databases, embeddings, and semantic indexers are deliberately omitted in this phase. |

---

### 2. Available Backend Tools

| Tool Name | Parameters | Purpose & Guarantees |
|---|---|---|
| `get_crm_schema` | *None* | Returns the authoritative description of all 15 LeadSync CRM fields, expected data types, nullability, accepted enums (`CRM_STATUS_VALUES`, `DATA_SOURCE_VALUES`), and validation rules. Read-only, zero lead data access. |
| `retrieve_mapping_examples` | `{ headers: string[] }` | Queries a curated dictionary of real-world CSV aliases (e.g., `Cust_Name` ➔ `name`, `Mob no` ➔ `mobile_without_country_code`). Returns bounded, high-confidence deterministic examples. Never accesses private customer records. |
| `validate_mapping` | `{ mappings: [{ source, target }] }` | Server-side validator that rejects non-existent CRM target fields, detects missing source columns, flags conflicting mappings (multiple columns mapped to one scalar field), and checks contact coverage. |

---

### 3. Two-Stage Extraction Architecture

```text
CSV Upload (e.g. messy_manual_spreadsheet.csv)
   │
   ▼
[Extract Distinct Headers once per import]
   │
   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Stage A: Gemini Function-Calling Mapping Planning                      │
│                                                                        │
│ 1. Model receives headers + 3 tool declarations (AUTO mode)            │
│ 2. Gemini dynamically invokes tools (e.g. get_crm_schema)             │
│ 3. Backend verifies tool name on allowlist, validates args with Zod    │
│ 4. Backend executes tool and returns { functionResponse }              │
│ 5. Gemini receives tool outputs and reasons over mappings             │
│ 6. Gemini optionally calls retrieve_mapping_examples & validate_mapping│
│ 7. Gemini returns final mapping plan JSON                              │
│ 8. Server authoritatively validates mapping plan                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Validated Mapping Plan
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Stage B: Concurrent Batch Record Extraction                            │
│                                                                        │
│ - Batch size: 20 rows, Concurrency: 3 workers, Max retries: 3         │
│ - Validated column mappings injected into extraction prompt            │
│ - Strict Zod validation (AIExtractedRowSchema) on every row            │
│ - Authoritative server-side skip rule: shouldSkipRow()                 │
│ - Staged in PendingImport (status: PENDING)                           │
│ - Streamed to frontend via Server-Sent Events (SSE)                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
           Human Review ➔ Explicit Owner Approval ➔ Atomic DB Commit
```

---

### 4. Tool Execution Limits & Safety Boundaries

- **Strict Allowlist**: Only explicitly registered tools (`get_crm_schema`, `retrieve_mapping_examples`, `validate_mapping`) can ever be dispatched. Unknown tool requests return structured errors without crashing.
- **Zod Argument Validation**: Every tool's arguments are parsed and validated by strict Zod schemas before execution.
- **Bounded Tool Calls**: Maximum **5 total tool calls** and maximum **3 conversation rounds** per mapping operation to prevent recursion and runaway API costs.
- **Read-Only Guarantees**: None of the tools possess database mutation capabilities. Tools cannot approve imports, insert leads, update pending imports, or execute SQL.
- **Prompt Injection Defense**: Source CSV column headers and values are encapsulated strictly as data parameters, never interpreted as system prompts or tool declarations.
- **Timeouts & Safe Fallback**: If tool orchestration times out or encounters Gemini service unavailability, the system falls back to direct heuristic extraction under a documented policy and records `fallbackOccurred: true` in telemetry.

---

### 5. Example Real Tool-Call Trace

```json
[
  {
    "turn": 1,
    "role": "model",
    "call": {
      "name": "retrieve_mapping_examples",
      "args": { "headers": ["Cust_Name", "Mob_No", "Emal", "staus"] }
    }
  },
  {
    "turn": 1,
    "role": "tool_response",
    "response": {
      "totalMatches": 4,
      "examples": [
        { "sourceHeader": "Cust_Name", "matchedAlias": "cust_name", "targetField": "name", "confidence": "high" },
        { "sourceHeader": "Mob_No", "matchedAlias": "mob_no", "targetField": "mobile_without_country_code", "confidence": "high" },
        { "sourceHeader": "Emal", "matchedAlias": "emal", "targetField": "email", "confidence": "high" },
        { "sourceHeader": "staus", "matchedAlias": "staus", "targetField": "crm_status", "confidence": "high" }
      ]
    }
  },
  {
    "turn": 2,
    "role": "model",
    "call": {
      "name": "validate_mapping",
      "args": {
        "mappings": [
          { "source": "Cust_Name", "target": "name" },
          { "source": "Mob_No", "target": "mobile_without_country_code" },
          { "source": "Emal", "target": "email" },
          { "source": "staus", "target": "crm_status" }
        ]
      }
    }
  },
  {
    "turn": 2,
    "role": "tool_response",
    "response": {
      "valid": true,
      "errors": [],
      "warnings": [],
      "validatedMappings": [
        { "source": "Cust_Name", "target": "name" },
        { "source": "Mob_No", "target": "mobile_without_country_code" },
        { "source": "Emal", "target": "email" },
        { "source": "staus", "target": "crm_status" }
      ]
    }
  },
  {
    "turn": 3,
    "role": "model",
    "finalOutput": {
      "mappings": [
        { "source": "Cust_Name", "target": "name", "reasoning": "Customer full name" },
        { "source": "Mob_No", "target": "mobile_without_country_code", "reasoning": "Mobile phone" },
        { "source": "Emal", "target": "email", "reasoning": "Primary email" },
        { "source": "staus", "target": "crm_status", "reasoning": "Lead qualification status" }
      ]
    }
  }
]
```

---

### 6. Observability, Telemetry & PII-Safe Logging

LeadSync integrates structured telemetry tracking ([`toolObservability.service.ts`](backend/src/services/toolObservability.service.ts)) to observe and monitor Gemini function-calling behavior in real time:

- **Metrics Collected**:
  - `totalModelRequests`: Number of HTTP exchanges with Gemini.
  - `conversationRounds`: Number of turn cycles completed.
  - `toolCallsRequested` / `toolCallsExecuted`: Counts and names of dispatched tools.
  - `toolCallsFailed`: Tools that rejected invalid arguments or exceeded limits.
  - `toolExecutionTimesMs`: Exact execution latency per tool call.
  - `tokenUsage`: Prompt tokens, candidates tokens, and total tokens tracked via Gemini's `usageMetadata`.
  - `fallbackOccurred`: Boolean flag and sanitized reason code indicating whether the pipeline completed via tool-planned mappings or fell back to heuristic batch extraction.
- **Zero-PII Defensive Logging**:
  - All log entries pass through regex sanitizers ([`sanitizer.ts`](backend/src/lib/sanitizer.ts)) that redact customer emails, phone numbers, auth tokens, database credentials, and raw lead data.
  - Observability logs output aggregated execution metrics without leaking row content:
    ```text
    [ToolObservability] Completed in 842ms | Requests: 3 | Rounds: 3 | Tools Called: 2 (retrieve_mapping_examples, validate_mapping) | Executed: 2 | Failed: 0 | Fallback: false
    ```

---

### 7. Local Setup & Manual Testing with Gemini API

1. Configure your `.env` in `backend/`:
   ```env
   GEMINI_API_KEY="your-real-gemini-api-key"
   GEMINI_MODEL="gemini-2.5-flash"
   ```
2. Start the backend:
   ```bash
   cd backend && npm run dev
   ```
3. Test with a **straightforward CSV** (`samples/google_ads_export.csv`):
   - Notice: Model evaluates standard headers and completes with minimal or zero tool calls.
4. Test with a **messy CSV** (`samples/messy_manual_spreadsheet.csv`):
   - Notice: Model requests `retrieve_mapping_examples` and `validate_mapping`, resolves abbreviations like `Mob no` and `staus`, and produces validated CRM records.
5. Inspect local tool observability summary in backend logs:
   ```text
   [ToolObservability] Completed in 842ms | Requests: 3 | Rounds: 3 | Tools Called: 2 (retrieve_mapping_examples, validate_mapping) | Executed: 2 | Failed: 0 | Fallback: false
   ```

---

### 8. Controlled SDK Migration Roadmap (`@google/generative-ai` ➔ `@google/genai`)

The current implementation leverages Google's native function calling via `@google/generative-ai` (with genuine `FunctionDeclaration` OpenAPI specifications and multi-turn `functionResponse` message cycles). Google has introduced `@google/genai` (The Google Gen AI SDK) as the unified successor SDK. To ensure zero downtime, guaranteed offline CI builds, and full backward compatibility, the migration follows this controlled 4-stage transition:

#### Architectural Mapping

| Feature | Legacy SDK (`@google/generative-ai`) | New SDK (`@google/genai`) | Transition Strategy |
|---|---|---|---|
| **Client Initialization** | `new GoogleGenerativeAI(apiKey)` | `new GoogleGenAI({ apiKey })` | Wrap in singleton provider (`aiProvider.ts`) |
| **Model & Instruction** | `genAI.getGenerativeModel({ model, systemInstruction })` | Model passed per call or in config (`ai.chats.create`) | Unified config builder |
| **Function Declarations** | `FunctionDeclaration` with `FunctionDeclarationSchemaType` | Declarations with `Type` enum from `@google/genai` | Abstract tool declaration schema mapper |
| **Tool Execution Response** | `{ functionResponse: { name, response } }` Part | `{ functionResponse: { name, response } }` Part | Compatible message payload structure |
| **Batch Structured Extraction** | `model.generateContent(prompt)` | `ai.models.generateContent({ model, contents })` | Drop-in extraction adapter |
| **Cancellation & Timeouts** | `AbortSignal` via `SingleRequestOptions.signal` | `AbortSignal` via client call options | Preserves robust `AbortController` cancellation |

#### Migration Phases

1. **Phase 1: Robust Baseline (Completed)**:
   - Default model set to active `gemini-2.5-flash`.
   - Tool registry hardened with own-property checks (`Object.prototype.hasOwnProperty`).
   - Request cancellation backed by `AbortController` and `AbortSignal` inside `Promise.race()`.
   - Comprehensive test suite (184 backend unit & integration tests) locking all contracts.
2. **Phase 2: Dependency & Adapter Layer**:
   - Install `@google/genai` when network access is enabled in production/deployment CI.
   - Implement an abstraction wrapper `IGeminiClient` allowing runtime or environment toggle between SDKs (`USE_GENAI_SDK=true/false`).
3. **Phase 3: Dual-Run Shadow Validation**:
   - Run tool orchestrator against `@google/genai` in staging with automated parity checks against the mock test suite.
4. **Phase 4: Deprecation Cleanup**:
   - Remove `@google/generative-ai` from `package.json` and prune legacy adapter code.

---

## 🐳 Docker Deployment

The application includes multi-stage Dockerfiles and `docker-compose.yml`:

```bash
cp .env.example .env
docker-compose up --build -d
```
- **Frontend**: `http://localhost:3000`
- **Backend API**: `http://localhost:4000`

---

## 🧪 Testing Suite

### Run Backend Tests
```bash
cd backend
npm test
# 184 tests passing across 10 suites (tools, geminiFunctionCalling, toolIntegrationWorkflow, auth, zodSchemas, aiExtractor, approvalWorkflow, csvParser, validators, importOrchestrator)
```

### Run Frontend Tests
```bash
cd frontend
npm test
# 44 tests passing across 4 suites (authAndPublicMode, CSVImporterWorkflow, api, utils)
```

### Build Verification
```bash
cd backend && npm run build     # tsc compile check
cd ../frontend && npm run build # Next.js webpack build
```

---

## ⚙️ Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `GEMINI_API_KEY` | **Yes** | — | Google Gemini API key |
| `GOOGLE_CLIENT_ID` | **Yes** | — | Google OAuth 2.0 Web Client ID |
| `GOOGLE_CLIENT_SECRET` | **Yes** | — | Google OAuth 2.0 Client Secret |
| `GOOGLE_REDIRECT_URI` | **Yes** | `http://localhost:3000/api/auth/google/callback` | OAuth redirect URI |
| `OWNER_GOOGLE_EMAIL` | **Yes** | — | Configured owner Google email address |
| `OWNER_GOOGLE_SUB` | No | — | Optional Google subject ID pinning |
| `SESSION_SECRET` | **Yes** | — | Secret for signing OAuth cookies (min 32 chars) |
| `APP_ORIGIN` | No | `http://localhost:3000` | Allowed frontend origin for CSRF & cookies |
| `FRONTEND_URL` | No | `http://localhost:3000` | Frontend redirect destination |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model name |
| `PORT` | No | `4000` | Server listening port |
| `PENDING_IMPORT_TTL_HOURS`| No | `24` | Hours before pending import expires |
| `BATCH_SIZE` | No | `20` | Row count per AI batch |
| `BATCH_CONCURRENCY` | No | `3` | Concurrent AI requests |
| `BATCH_MAX_RETRIES` | No | `3` | Max exponential backoff attempts |

### Frontend (`frontend/.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `BACKEND_PROXY_URL` | **Yes** | `http://localhost:4000` | Backend API URL for server-side Next.js rewrites |
| `NEXT_PUBLIC_BACKEND_URL` | No | `""` (relative `/api/*`) | Optional browser API URL override |

---

## 🧪 Test CSV Datasets

Four test datasets are available in `/samples/`:
1. `facebook_leads_export.csv` — `full_name`, `phone_number`, ad platform metadata.
2. `google_ads_export.csv` — `Customer Name`, combined `Location`, irrelevant campaign columns.
3. `realestate_crm_dump.csv` — Dual mobile numbers, DD-MM-YYYY dates, enum values.
4. `messy_manual_spreadsheet.csv` — Header typos, ambiguous statuses, mixed format notes.

---

## 📝 Known Limitations & Production Considerations

- **Single-Owner Application**: LeadSync is designed specifically as a single-owner portfolio application with owner-only privileges and empty public read-only mode for portfolio visitors.
- **Gemini Rate Limits**: On the free tier, Gemini API has request-per-minute limits. Production deployments with large CSVs (>1,000 rows) should utilize a paid tier key.
- **Ambiguous Data Source**: The AI intentionally abstains from guessing CRM data source if the CSV does not contain clear project signals.
