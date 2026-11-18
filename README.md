# GrowEasy — Enterprise AI-Powered CSV Importer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-TypeScript-white)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-blue)](https://prisma.io/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue)](https://docker.com/)

An enterprise-grade, AI-powered CSV importer built for the CRM ecosystem. By leveraging the advanced semantic capabilities of Google's Gemini AI, this system intelligently maps wildly inconsistent, schema-less CSV dumps (e.g., Facebook Leads, Google Ads, real-estate CRM exports, and messy manual spreadsheets) directly into a strictly validated CRM schema. 

Say goodbye to rigid templates, frustrating column mappings, and manual data cleanup.

---

## 🏗️ System Architecture & Human-in-the-Loop Workflow

GrowEasy enforces a **Human-in-the-Loop (HITL) approval architecture**. Extracted leads are **never** written directly into CRM production tables (`imports`, `leads`) during AI extraction. Instead, the pipeline separates extraction from persistence into two distinct, auditable phases:

```text
CSV Upload ➔ Gemini AI Extraction ➔ Server-side Validation ➔ Temporary Staging (pending_imports)
                                                                             │
                                              ┌──────────────────────────────┴──────────────────────────────┐
                                              ▼                                                             ▼
                                     [Explicit Approval]                                           [Explicit Rejection]
                                              │                                                             │
                              Server Revalidation + Transaction                             Purge Staged Records (PII)
                                              │                                                             │
                                              ▼                                                             ▼
                                    imports & leads tables                                        0 CRM Records Written
```

### Detailed Architecture Diagram

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                Frontend (Next.js 14)                                   │
│                                                                                        │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐  │
│  │ 1. Upload    │ ➔ │ 2. Preview   │ ➔ │ 3. SSE Stream   │ ➔ │ 4. Review AI Results │  │
│  │ (Dropzone)   │   │ (PapaParse)  │   │ Extraction View │   │ (Interactive Table)  │  │
│  └──────────────┘   └──────────────┘   └─────────────────┘   └──────────┬───────────┘  │
│                                                                         │              │
│                                           ┌─────────────────────────────┴──────────┐   │
│                                           ▼                                        ▼   │
│                                  [Approve & Import]                        [Reject Import] │
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
│  │ Phase A: Extract      │ ➔ │ Import Orchestrator      │ ➔ │ Temporary Staging │  │   │
│  │ (multer + csv-parse)  │   │ (Gemini Batch + Backoff) │   │ (pending_imports) │  │   │
│  └───────────────────────┘   └──────────────────────────┘   └───────────────────┘  │   │
│                                                                                    │   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │   │
│  │ Phase B: POST /api/imports/:id/approve                                       │  │   │
│  │   1. Load pending import & verify eligibility (not expired/rejected)         │  │   │
│  │   2. Server-side schema revalidation (Zod)                                   │  │   │
│  │   3. Atomic transaction (Prisma $transaction)                                │  │   │
│  │   4. Idempotency protection against double-clicks/retries                    │  │   │
│  │   5. Commit to final imports + leads tables                                  │  │   │
│  └──────────────────────────────────────────────────────────────────────────────┘  │   │
│                                                                                    │   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │   │
│  │ Phase C: POST /api/imports/:id/reject                                        │  │   │
│  │   1. Mark status as REJECTED & purge staged PII                              │◀─┘   │
│  │   2. Prevent any future approval                                             │      │
│  └──────────────────────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────┬──────────────────────────────────────────┘
                                              │
┌─────────────────────────────────────────────▼──────────────────────────────────────────┐
│                             PostgreSQL (via Prisma ORM)                                │
│   pending_imports (Staging) ➔ imports table ➔ leads table ➔ skipped_rows table         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ Enterprise Features

- **Human-in-the-Loop Review & Approval** — Requires explicit human inspection of AI-transformed CRM fields before any records are committed to production database tables.
- **Schema-Agnostic AI Extraction** — Flawlessly maps arbitrary CSV columns, normalizes ISO 8601 dates, and extracts complex phone/country codes without requiring manual intervention.
- **Real-Time Streaming UX** — Server-Sent Events (SSE) stream progress dynamically to an in-button progress bar, keeping the user informed during heavy AI workloads.
- **Robust Concurrency & Reliability** — Processes records in chunked batches utilizing `p-limit` for concurrency control, wrapped in a defensive **exponential backoff retry mechanism** to gracefully recover from API rate limits.
- **High-Performance UI** — Built on Next.js 14, featuring entirely virtualized tables (`@tanstack/react-virtual`), guaranteeing sub-millisecond scrolling performance when visualizing tens of thousands of records.
- **Production-Ready Dockerization** — Optimized multi-stage Dockerfiles ensure minimal image sizes and non-root runtime environments, with streamlined orchestration via `docker-compose`.
- **Database Persistence & Auditing** — Fully typed Prisma ORM interfacing with PostgreSQL, permanently capturing successful leads and securely documenting rejection reasons for skipped rows.

---

## 🛡️ Strict AI-Output Validation & Reliability Features

The system implements rigorous data-quality and fault-tolerance safeguards to ensure that non-deterministic AI outputs can be trusted in production environments:

- **Runtime Zod Schema Validation (`zodSchemas.service.ts`)**:
  - All AI batch responses and individual rows are validated against `AIExtractedRowSchema` before being processed.
  - Strips markdown code blocks, normalizes string fields, coerces empty/null-like strings to `null`, and verifies batch array dimensions.
  - Rejects malformed dates (e.g. invalid string formats) and normalizes ISO 8601 strings so invalid date objects never reach Prisma.
  - Enforces strict enum values for `crm_status` (`GOOD_LEAD_FOLLOW_UP`, `DID_NOT_CONNECT`, `BAD_LEAD`, `SALE_DONE`) and `data_source` (`leads_on_demand`, `meridian_tower`, `eden_park`, `varah_swamy`, `sarjapur_plots`).
  - Validates ITU-T E.164 phone formats and standardizes country code splitting (+prefix with 1-4 digits, local mobile digits 5-15).
- **Authoritative Server-Side Skip Enforcement**:
  - The AI's `skip` and `skipReason` fields are treated strictly as advisory hints.
  - The backend authoritatively re-evaluates `shouldSkipRow(email, mobile)` to guarantee rows with valid contact data are never discarded due to model hallucination.
- **Explicit Distinction: Skipped vs. Failed Rows**:
  - **Skipped Rows**: Rows intentionally omitted because they genuinely lack contact information (no email and no phone number).
  - **Failed Rows**: Rows that failed due to AI batch exhaustion, malformed JSON, or schema validation errors.
  - Failed rows are tracked independently in SSE progress events, visualized in dedicated inspection tabs in the Review UI, and preserved in PostgreSQL with `[AI_FAILURE]` auditing tags.
- **Error-Classified Exponential Backoff Retry (`withRetry`)**:
  - Structural errors (malformed JSON, batch length discrepancies) trigger exponential backoff retries (1s, 2s, 4s).
  - Individual row-level validation issues fail only that row without discarding the rest of the batch or wasting API quota on useless retries.
- **Zero False Database Success Reporting**:
  - Persistence failures during staging or approval report `0` imported leads and surface explicit error messages rather than falsely claiming success or returning undefined IDs.
- **Client-Side Interrupted Stream Detection**:
  - The frontend stream reader (`extractLeads`) mandates receipt of a terminal `complete` SSE event frame.
  - Premature stream disconnects, network drops, or backend `error` events immediately reject the promise, preventing incomplete imports from navigating or being accepted.
- **Defensive, PII-Safe Logging**:
  - Server logs capture error classes and high-level pipeline status while strictly preventing full stack dumps or raw lead data (names, emails, phones) from leaking into console logs.

---

## 🤖 AI Provider: Google Gemini 2.5 Flash

**Why Gemini 2.5 Flash?**
- **1M Token Context Window**: Provides vast headroom for extremely detailed system prompting alongside massive data batches.
- **High-Speed Inference**: Guarantees ultra-low latency chunk processing, ensuring the SSE streaming UX feels instantaneous.
- **JSON-Enforced Output**: Strict adherence to `application/json` response parameters forces completely valid JSON output.
- **Rigid Prompt Engineering**: The model acts purely as a deterministic data-mapping engine. It natively handles semantic mapping (e.g. mapping "Contact Name" to `name`), enum enforcement, and complex logic like isolating Country Codes from raw mobile strings.

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- **Node.js 20+**
- A **PostgreSQL** database (e.g., [Neon](https://neon.tech) or [Supabase](https://supabase.com))
- A **Google AI Studio** [Gemini API key](https://aistudio.google.com)

### 1. Repository Setup

```bash
git clone https://github.com/Sayantan-dev1003/GrowEasy-Task
cd groweasy-csv-importer
```

### 2. Backend Initialization

```bash
cd backend
cp .env.example .env
# Important: Edit .env and supply your DATABASE_URL and GEMINI_API_KEY
npm ci
npx prisma db push      # Initialize database schema
npx prisma generate     # Generate typed Prisma client
npm run dev             # Launches the API on port 4000
```

### 3. Frontend Initialization

```bash
cd frontend
cp .env.example .env.local
# Verify NEXT_PUBLIC_BACKEND_URL=http://localhost:4000
npm ci
npm run dev             # Launches the Web App on port 3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🐳 Docker Deployment

The application is fully containerized for immediate production deployment.

```bash
# 1. Copy the environment variables
cp .env.example .env

# 2. Build and launch the orchestrated services
docker-compose up --build -d
```
- **Frontend** will be exposed at `http://localhost:3000`
- **Backend API** will be exposed at `http://localhost:4000`

---

## 🧪 Testing Suite

```bash
# Run backend unit tests
cd backend && npm test

# Generate backend coverage report
cd backend && npm run test:coverage

# Run frontend tests
cd frontend && npm test
```

**Test coverage includes:**
- **CSV Edge Cases:** BOM markers, duplicate headers, empty files, malformed row handling.
- **Batch Orchestration:** Chunker logic and concurrency boundaries.
- **AI Validation:** Enum validators (`crm_status`, `data_source`), Country Code splitting, and date normalization algorithms.

---

## 📁 Directory Structure

```text
groweasy/
├── backend/
│   ├── prisma/schema.prisma          # Relational DB schema
│   ├── src/
│   │   ├── index.ts                  # Express server entry
│   │   ├── routes/                   # API Routing Controllers
│   │   ├── services/                 # Business Logic (CSV, AI, Orchestration)
│   │   └── types/index.ts            # Global Type Definitions
│   ├── Dockerfile                    # Multi-stage optimized Dockerfile
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── app/                      # Next.js App Router (Pages & Layouts)
│   │   ├── components/               # UI Components & Importer Modals
│   │   ├── lib/api.ts                # Client API & SSE Stream Listener
│   │   └── types/index.ts            # Shared Frontend Types
│   ├── public/samples/               # Provided test CSVs
│   └── Dockerfile                    # Standalone optimized Dockerfile
├── samples/                          # 4 pre-configured test CSVs
├── docker-compose.yml                # Microservices orchestration
└── README.md
```

---

## ⚙️ Environment Variables

### Backend (`backend/.env`)

| Variable | Requirement | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **Required** | — | Connection string for PostgreSQL |
| `GEMINI_API_KEY` | **Required** | — | Valid Google Gemini API Key |
| `GEMINI_MODEL` | Optional | `gemini-1.5-flash` | Selected Gemini Inference Model |
| `PORT` | Optional | `4000` | Express listening port |
| `BATCH_SIZE` | Optional | `20` | Row count per AI request chunk |
| `BATCH_CONCURRENCY` | Optional | `3` | Maximum simultaneous AI requests |
| `BATCH_MAX_RETRIES` | Optional | `3` | Max exponential backoff attempts |

### Frontend (`frontend/.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | ✅ | `http://localhost:4000` | Backend API base URL |

---

## 🧪 Test CSVs

Four sample CSVs are included in `/samples/` to test different real-world shapes:

| File | What it tests |
|---|---|
| `facebook_leads_export.csv` | `full_name`, `phone_number`, `created_time`, ad platform metadata |
| `google_ads_export.csv` | `Customer Name`, combined `Location`, irrelevant campaign columns |
| `realestate_crm_dump.csv` | Dual mobile columns, DD-MM-YYYY dates, `data_source` enum values |
| `messy_manual_spreadsheet.csv` | Typos in headers (`Emal`, `staus`), extra email in notes, ambiguous status strings |

---

## 🏆 Key Workflow Features

- ✅ **Human-in-the-Loop (HITL) Workflow** — Zero CRM leads or imports are written until the user explicitly reviews and approves the AI transformation.
- ✅ **Database-Backed Staging (`PendingImport`)** — Staged records are persisted in PostgreSQL, preventing client-side forgery and server-restart loss.
- ✅ **Server-Side Revalidation** — Strict Zod schema revalidation runs upon approval before persisting records into production tables.
- ✅ **Atomic Persistence & Idempotency** — Transactions prevent partial imports, double-clicks, retries, and race conditions from creating duplicate records.
- ✅ **Privacy & Retention Policy** — Pending imports automatically expire after 24 hours; rejecting an import immediately purges staged PII.
- ✅ **Interactive Review Modal** — Filterable and scrollable review table showing transformed fields (Name, Email, Country Code, Mobile, Status, Source, Notes).
- ✅ **Skipped & Failed Row Inspectors** — Dedicated inspection tabs showing raw data and human-readable reasons for non-imported rows.
- ✅ **Drag & Drop Upload & SSE Streaming** — Real-time progress updates stream during Gemini chunk processing.
- ✅ **Virtualized Tables** — High-performance table virtualization with `@tanstack/react-virtual`.
- ✅ **Comprehensive Automated Tests** — 110 backend tests and 34 frontend tests verifying unit algorithms, state transitions, and edge cases.

---

## 🔒 Security & Practical Constraints

> [!IMPORTANT]
> **Authentication & Authorization Demo Notice**:
> This application is currently configured as a development demonstration without an integrated user authentication system.
> - Clicking **Approve** or **Reject** demonstrates the state machine and data integrity workflow but **does not enforce authenticated reviewer identity or Role-Based Access Control (RBAC)**.
> - Pending import identifiers (`cuid`) provide isolated staging access in this demo, but **are not a substitute for cryptographically signed session tokens or production authentication**.
> - **Production Requirement**: A production release must require authenticated login (e.g., NextAuth, Auth0, or Supabase Auth), reviewer audit logging (`approvedByUserId`, `approvedAt`), and role-based permissions (e.g. `roles: ['admin', 'crm_manager']`).

---

## 📋 Manual Testing Guide

Follow these steps to manually verify the complete workflow:

### 1. Happy Path: Approve and Commit
1. Open the app at `http://localhost:3000`.
2. Click **Import Leads** and drop one of the sample CSVs from `/samples/` (e.g., `facebook_leads_export.csv`).
3. Click **Process with AI** on the preview screen.
4. Observe the in-button progress bar as Gemini batches stream.
5. Once complete, notice you are **not** navigated away; the **Review AI Results** screen appears.
6. Review the AI-mapped fields in the table, verify Status pills and contact splits.
7. Click **Approve & Import**. Observe the loading state and verify navigation to `/manage-leads?importId=...` only after database persistence succeeds.

### 2. Rejection Path: Zero Final Records
1. Upload a CSV and click **Process with AI**.
2. On the **Review AI Results** step, click **Reject Import**.
3. Confirm the rejection message appears: *"This pending import has been rejected. No leads were written into your CRM."*
4. Navigate to Manage Leads and verify that **no new import** and **no new leads** were created.

### 3. Inspection of Skipped & Failed Rows
1. Upload `messy_manual_spreadsheet.csv` or `realestate_crm_dump.csv`.
2. On the Review screen, observe the **Skipped Rows** stat card.
3. Click the **Skipped** tab to inspect the rows lacking contact info and view their reasons.

### 4. Idempotency & Concurrency Verification
1. Repeatedly clicking **Approve & Import** on the same pending import ID will return the existing import ID without duplicating `Import` or `Lead` rows.
2. An import that has been rejected cannot be approved (`400 Bad Request`).
3. An import whose expiration timestamp has passed cannot be approved (`400 Bad Request`).

---

## 📝 Known Limitations

- The AI abstains from guessing `data_source` if it's ambiguous — this is intentional per spec
- Very large CSVs (>1000 rows) will take several minutes due to Gemini rate limits
- The free Gemini tier has RPM limits; production use should use a paid key
- Reviewer identity and RBAC must be added before deploying to multi-tenant production (see Security section)
