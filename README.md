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
│  ┌───────────────────────┐   ┌──────────────────────────┐   ┌───────────────────┐  │   │
│  │ Phase A: Extract      │ ➔ │ Import Orchestrator      │ ➔ │ Database Staging  │  │   │
│  │ (multer + csv-parse)  │   │ (Gemini Batch + Backoff) │   │ (pending_imports) │  │   │
│  └───────────────────────┘   └──────────────────────────┘   └───────────────────┘  │   │
│                                                                                    │   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │   │
│  │ Phase B: POST /api/imports/:id/approve (Protected by HMAC-SHA256 Auth & RBAC)│  │   │
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
│  │ Phase C: POST /api/imports/:id/reject (Protected by HMAC-SHA256 Auth & RBAC) │  │   │
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

### Authentication & Role-Based Access Control (RBAC)
- **HMAC-SHA256 Token Verification**: Stateless, cryptographically signed tokens (`backend/src/middleware/auth.middleware.ts`) protect pending import review, approval, rejection, and lead management endpoints.
- **Role Hierarchy**:
  - `admin`: Full access to extraction, review, approval, rejection, and retention cleanup.
  - `reviewer`: Access to review, approve, and reject imports assigned to them or unassigned.
  - `user`: Restricted to viewing own imports.
- **Ownership Verification (`isAuthorizedForPendingImport`)**: Pending imports are associated with a `userId`. Non-admin users cannot review, approve, or reject imports belonging to another user.
- **Request Headers**:
  - `Authorization: Bearer <token>`
  - Or `x-api-key: <api-key>`
- **Development Fallback**: In local development, `ALLOW_DEV_ANONYMOUS=true` allows unauthenticated requests with a default developer reviewer identity.

> [!NOTE]
> **Production Security Note**: For enterprise multi-tenant deployments, pair this HMAC-SHA256 middleware with an OAuth2 / OIDC identity provider (e.g. Auth0, Clerk, or Supabase Auth) and manage cryptographic keys via a KMS / Secrets Manager.

---

## 🖥️ Frontend UX & Human Review Screen

- **SSE Stream Integrity**: `CSVImporter.tsx` verifies receipt of a valid `pendingImportId` before transitioning to the review step. Malformed or failed extractions show a recoverable error alert instead of a blank review screen.
- **No Premature Navigation**: Navigation to `/manage-leads` occurs **only** after human approval is confirmed by the backend database transaction.
- **Double-Click Protection**: Approval and rejection buttons disable immediately with loading states to prevent race conditions or repeated submissions.
- **Complete CRM Field Exposure (`ReviewStep.tsx`)**:
  - Core fields displayed in the virtual table: Name, Contact Info (Email, Phone, Country Code), Status pill, Source badge.
  - **Expandable Row Details**: Click the chevron or press `Enter`/`Space` to expand detailed fields: Location (City, State, Country), Possession Timeline, Lead Owner, CRM Notes, and Description.
  - **Virtualized Performance**: Maintained via `@tanstack/react-virtual` with dynamic row measurement, ensuring 60fps scrolling over thousands of rows.

---

## 📡 API Reference

### 1. `POST /api/extract`
Uploads a CSV file and streams AI extraction results via Server-Sent Events (SSE).
- **Headers**: `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`
- **Body**: `file`: CSV file
- **SSE Events**:
  - `progress`: `{ type: 'progress', batchIndex, totalBatches, batchRecords, batchSkipped, batchFailed }`
  - `complete`: `{ type: 'complete', pendingImportId, totalValid, totalSkipped, totalFailed }`
  - `error`: `{ type: 'error', message }`

### 2. `GET /api/imports/pending/:id`
Retrieves a pending import by ID for review.
- **Headers**: `Authorization: Bearer <token>`
- **Response**: `200 OK` with `PendingImportDTO`

### 3. `POST /api/imports/:id/approve`
Approves and commits a pending import into PostgreSQL tables (`imports`, `leads`, `skipped_rows`).
- **Headers**: `Authorization: Bearer <token>`
- **Response**: `200 OK` with `{ message, importId, totalImported, totalSkipped }`

### 4. `POST /api/imports/:id/reject`
Rejects a pending import and purges staged PII.
- **Headers**: `Authorization: Bearer <token>`
- **Response**: `200 OK` with `{ message, pendingImportId, status: 'REJECTED' }`

### 5. `POST /api/imports/cleanup`
Admin maintenance endpoint to clean up expired pending imports and purge staged PII.
- **Headers**: `Authorization: Bearer <admin-token>`
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
# Edit .env with your DATABASE_URL, GEMINI_API_KEY, and JWT_SECRET
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
# 110 tests passing across 6 suites (zodSchemas, aiExtractor, approvalWorkflow, csvParser, validators, importOrchestrator)
```

### Run Frontend Tests
```bash
cd frontend
npm test
# 34 tests passing across 3 suites (CSVImporterWorkflow, api, utils)
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
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model name |
| `PORT` | No | `4000` | Server listening port |
| `JWT_SECRET` | No | Random dev string | HMAC-SHA256 token verification key |
| `API_KEY` | No | — | Optional service API key |
| `ALLOW_DEV_ANONYMOUS`| No | `false` | Allow unauthenticated dev requests |
| `PENDING_IMPORT_TTL_HOURS`| No | `24` | Hours before pending import expires |
| `BATCH_SIZE` | No | `20` | Row count per AI batch |
| `BATCH_CONCURRENCY` | No | `3` | Concurrent AI requests |
| `BATCH_MAX_RETRIES` | No | `3` | Max exponential backoff attempts |

### Frontend (`frontend/.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | **Yes** | `http://localhost:4000` | Backend API URL |
| `NEXT_PUBLIC_API_TOKEN` | No | `demo-reviewer-token` | Default reviewer token |

---

## 🧪 Test CSV Datasets

Four test datasets are available in `/samples/`:
1. `facebook_leads_export.csv` — `full_name`, `phone_number`, ad platform metadata.
2. `google_ads_export.csv` — `Customer Name`, combined `Location`, irrelevant campaign columns.
3. `realestate_crm_dump.csv` — Dual mobile numbers, DD-MM-YYYY dates, enum values.
4. `messy_manual_spreadsheet.csv` — Header typos, ambiguous statuses, mixed format notes.

---

## 📝 Known Limitations & Production Considerations

- **Multi-Tenant Identity**: Uses HMAC-SHA256 token verification. In a large enterprise environment, integrate directly with an identity provider (Auth0, Okta, Supabase Auth).
- **Gemini Rate Limits**: On the free tier, Gemini API has request-per-minute limits. Production deployments with large CSVs (>1,000 rows) should utilize a paid tier key.
- **Ambiguous Data Source**: The AI intentionally abstains from guessing CRM data source if the CSV does not contain clear project signals.
