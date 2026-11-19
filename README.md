# LeadSync

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma&logoColor=white)](https://prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Google Gemini](https://img.shields.io/badge/Gemini-2.5--flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docker.com/)
[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=github-actions&logoColor=white)](https://github.com/features/actions)
[![Tests](https://img.shields.io/badge/Tests-263_passing-brightgreen?logo=jest&logoColor=white)](https://jestjs.io/)
[![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Zod](https://img.shields.io/badge/Zod-3-3E67B1?logo=zod&logoColor=white)](https://zod.dev/)

**An enterprise-grade, AI-assisted, human-in-the-loop CRM CSV importer powered by Google Gemini function calling.**

[Overview](#2-project-overview) · [Architecture](#6-system-architecture) · [Features](#8-complete-features--functionality) · [API Docs](#13-api-reference) · [Setup](#23-local-development-setup) · [Tests](#25-testing--quality-assurance)

</div>

---

## 1. Tech Stack & Technology Badges

| Layer | Technologies |
|---|---|
| **Frontend** | Next.js 16, React 18, TypeScript 5.7, TailwindCSS 3, TanStack Virtual, PapaParse, React Dropzone, Lucide React |
| **Backend** | Node.js 20, Express 4, TypeScript 5.7, Multer, csv-parse, p-limit, express-async-errors |
| **AI & LLM** | Google Gemini 2.5 Flash, `@google/genai` SDK v3, Gemini Function Calling (Tool Use), Structured Output |
| **Database** | PostgreSQL 15+, Prisma ORM 5, Prisma Migrate |
| **Auth** | Google OAuth 2.0 / OpenID Connect, PKCE, Nonce Verification, Server-Side Sessions, HttpOnly Cookies |
| **Validation** | Zod 3 (strict schemas, runtime parsing) |
| **Testing** | Jest 29, ts-jest, React Testing Library, jsdom |
| **DevOps** | Docker, Docker Compose, GitHub Actions CI |

---

## 2. Project Overview

**LeadSync** is an enterprise-grade, human-in-the-loop AI-assisted CSV import workflow designed for the CRM ecosystem. By leveraging Google's Gemini AI with native **Function Calling (Tool Use)**, the system intelligently maps inconsistent, schema-less CSV dumps — such as Facebook Leads exports, Google Ads data, real-estate CRM dumps, and messy manual spreadsheets — into a strictly validated CRM schema.

**Core Principle:** Extracted leads are **never** written directly into CRM production tables during AI extraction. All extractions are staged in a database-backed pending import record, strictly validated, and presented to a human reviewer. **Only explicitly approved data is committed to PostgreSQL in an atomic transaction.**

LeadSync is architected as a **single-owner portfolio application**: the owner operates a full-featured CRM import workflow, while unauthenticated public visitors can browse the portfolio UI and observe the human-in-the-loop workflow — with zero synthetic or mock CRM data exposed.

---

## 3. Problem Statement

Modern sales teams receive leads from dozens of heterogeneous data sources — advertising platforms, landing page forms, partner spreadsheets, real estate portals — each with their own column naming conventions, date formats, enum values, and structural layouts. Manually mapping and cleaning these inconsistent CSV files into a unified CRM schema is:

- **Time-consuming**: Hours spent on column remapping and data cleaning per import.
- **Error-prone**: Human mappers silently miss columns, misinterpret abbreviations, or coerce invalid values.
- **Risky for data integrity**: Garbage-in, garbage-out: unchecked AI-generated data can pollute the CRM with hallucinated, invalid, or malformed records.
- **Non-auditable**: Raw bulk imports bypass review, leaving no trail for rejected or skipped rows.
- **Privacy-unsafe**: Staging PII during processing without guaranteed cleanup creates compliance risk.

No existing open-source CRM importer combines AI field mapping, real-time streaming, human review, atomic transactions, and guaranteed PII purge into a single cohesive workflow.

---

## 4. Our Solution

LeadSync solves these problems through a **three-phase, AI-assisted, human-gated pipeline**:

1. **Phase A — AI Extraction**: Upload a CSV → Gemini's Function Calling API orchestrates tool calls to understand the schema, retrieve mapping examples, and validate proposed column mappings. Validated mappings drive concurrent batch extraction streamed live to the browser via Server-Sent Events.

2. **Phase B — Human Review**: All extracted results are staged in `pending_imports` as `PENDING`. The reviewer sees every extracted row in a virtualized table with expandable details — no CRM writes have occurred yet.

3. **Phase C — Atomic Commit or Purge**: The human clicks **Approve** (atomic Prisma transaction commits to `imports`, `leads`, and `skipped_rows`) or **Reject** (staged PII is immediately purged, zero CRM records written). Both paths are idempotent and race-condition-safe.

---

## 5. Key Highlights

- 🤖 **Genuine Gemini Function Calling** — multi-turn tool orchestration with `get_crm_schema`, `retrieve_mapping_examples`, and `validate_mapping` tools, not just prompt engineering.
- 🛡️ **Human-in-the-Loop Mandatory** — production CRM tables are never mutated by AI; every write requires explicit human approval.
- ⚡ **Real-Time SSE Streaming** — batch-by-batch progress streamed live to the browser during Gemini extraction.
- 🔒 **Defense-in-Depth Security** — Google OAuth 2.0 with PKCE, server-side sessions, CSRF protection, Zod strict validation, and PII sanitizer on all logs.
- 🧪 **263 Tests Passing** — 219 backend tests (12 suites) + 44 frontend tests (4 suites), plus a 26-scenario quantitative agent reliability evaluation framework.
- 🧹 **Guaranteed PII Purge** — staged PII JSON is wiped immediately on approval, rejection, or 24-hour TTL expiry — never retained longer than necessary.
- 📊 **Full Token & Cost Observability** — Gemini `usageMetadata` tracked per import, structured audit logs with correlation IDs, PII-safe sanitizer on all log output.
- 🎭 **Virtualized Performance** — `@tanstack/react-virtual` with dynamic row measurement for 60fps scrolling over thousands of extracted rows.

---

## 6. System Architecture

### High-Level Architecture

LeadSync is a fullstack monorepo with a Next.js frontend and an Express + TypeScript backend communicating over REST and Server-Sent Events (SSE). Both services connect to a shared PostgreSQL database via Prisma ORM. Gemini AI is called exclusively from the backend over HTTPS.

```
Browser (Next.js 16)
       │
       │  REST + SSE (HTTP)
       ▼
Express API (Node.js 20 / TypeScript)
       │
       ├──► Google Gemini API (Function Calling + Structured Output)
       │
       └──► PostgreSQL (via Prisma ORM)
                  ├── pending_imports  (staging)
                  ├── imports          (committed audit)
                  ├── leads            (CRM records)
                  ├── skipped_rows     (skipped audit)
                  ├── sessions         (server-side auth)
                  └── oauth_states     (PKCE / nonce store)
```

### Architecture Diagram

```
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

### Component Breakdown

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                Frontend (Next.js 16)                                   │
│                                                                                        │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐  │
│  │ 1. Upload    │ ➔ │ 2. Preview   │ ➔ │ 3. SSE Stream   │ ➔ │ 4. Review AI Results │  │
│  │ (Dropzone)   │   │ (PapaParse)  │   │ Extraction View │   │ (Virtual Table +     │  │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │  Expandable Details) │  │
│                                                               └──────────┬───────────┘  │
│                                                                          │              │
│                                           ┌──────────────────────────────┴──────────┐   │
│                                           ▼                                        ▼   │
│                                  [Approve & Import]                        [Reject Import] │
│                                  (Double-Click Safe)                                   │
│                                           │                                        │   │
│                                           ▼                                        ▼   │
│                                 Manage Leads View                      Zero CRM Leads Created  │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
               POST /api/extract (Phase A)  │
                         SSE Stream ◂───────┤
                                            ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                           Backend (Express + TypeScript)                               │
│                                                                                        │
│  Phase A: Extract      ➔  Import Orchestrator                 ➔  Database Staging     │
│  (multer + csv-parse)     1. Stage A: Tool Orchestrator           (pending_imports)   │
│                              (Gemini Function Calling)                                 │
│                           2. Stage B: Batch Extractor                                  │
│                              (Concurrency: 3, Backoff Retry: 3)                       │
│                                                                                        │
│  Phase B: POST /api/imports/:id/approve (Protected by Single-Owner Session)           │
│    1. Atomic conditional update: status: PENDING → APPROVED                           │
│    2. Server-side strict Zod revalidation                                              │
│    3. Atomic Prisma transaction: imports + leads + skipped_rows                       │
│    4. Mark COMMITTED & purge staged PII JSON                                           │
│    5. Idempotent return for repeated approval requests                                 │
│                                                                                        │
│  Phase C: POST /api/imports/:id/reject (Protected by Single-Owner Session)            │
│    1. Atomic conditional update: status: PENDING → REJECTED                           │
│    2. Purge staged records, skipped, and failed JSON (PII defense)                    │
│    3. Idempotent return for duplicate rejection requests                               │
└──────────────────────────────────┬────────────────────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼────────────────────────────────────────────────────┐
│                             PostgreSQL (via Prisma ORM)                                │
│   pending_imports (Staging) ➔ imports table ➔ leads table ➔ skipped_rows table        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Architecture

```
[CSV File]
    │
    ▼  POST /api/extract (multipart/form-data)
[multer middleware]
    │
    ▼  csv-parse
[Raw CSV Rows + Headers]
    │
    ├── Stage A: Gemini Function Calling Mapping Planner
    │       │
    │       ├── Tool: get_crm_schema       → Returns 15-field CRM schema definition
    │       ├── Tool: retrieve_mapping_examples → Returns alias dictionary matches
    │       └── Tool: validate_mapping     → Server validates proposed column mappings
    │
    ▼  Validated Mapping Plan
[Stage B: Concurrent Batch Extractor]  ← Batch size: 20, Concurrency: 3, Retries: 3
    │
    ▼  Zod AIExtractedRowSchema (strict)
[Validated Extracted Rows]
    │
    ├─► SSE Stream → Browser (progress events per batch)
    │
    ▼  Prisma
[pending_imports] status: PENDING
    │
    ├── Human Approve ──► Prisma $transaction ──► imports + leads + skipped_rows
    │                                          └► PII purge: records/skipped/failed = []
    │
    └── Human Reject  ──► Atomic status: REJECTED ──► PII purge immediately
```

---

## 7. End-to-End Workflow

1. **Sign In** — Owner authenticates via Google OAuth 2.0 (PKCE flow). Unauthenticated visitors see the read-only portfolio mode.
2. **Upload CSV** — Owner drags and drops or selects a CSV file. PapaParse renders a client-side preview.
3. **AI Extraction Begins** — `POST /api/extract` triggers the Gemini Function Calling orchestrator. The browser opens an SSE connection and renders live batch progress.
4. **Stage A: Mapping Planning** — Gemini requests tools (`get_crm_schema`, `retrieve_mapping_examples`, `validate_mapping`) to reason over CSV headers and produce a validated column mapping plan (max 5 tool calls, 3 rounds).
5. **Stage B: Batch Extraction** — Validated mappings drive concurrent batch extraction (batch size 20, concurrency 3, exponential backoff on transient errors). Every row is Zod-validated.
6. **Staging** — All results (valid, skipped, failed) are stored in `pending_imports` with `status: PENDING`. A `pendingImportId` is emitted via SSE `complete` event.
7. **Human Review** — The browser transitions to `ReviewStep.tsx`: a virtualized table showing every extracted row with expandable CRM field details, status pills, and source badges.
8. **Approve or Reject** — The owner makes an explicit decision:
   - **Approve**: Atomic conditional `PENDING → APPROVED`, server-side Zod revalidation, Prisma `$transaction` commits to `imports`, `leads`, `skipped_rows`, PII purged, `status: COMMITTED`.
   - **Reject**: Atomic conditional `PENDING → REJECTED`, staged PII immediately purged. Zero CRM records written.
9. **Lead Management** — After approval, the owner is navigated to `/manage-leads` with the new CRM records visible, searchable, and paginated.

---

## 8. Complete Features & Functionality

### CSV Upload & Processing

- **Drag-and-drop Dropzone** via `react-dropzone` with file type and size validation.
- **Client-side CSV preview** using PapaParse — renders column headers and row samples before upload.
- **Server-side parsing** using `csv-parse` for streaming, memory-efficient processing of large files.
- **Multi-source support**: Facebook Leads exports, Google Ads exports, real-estate CRM dumps, manual spreadsheets — any CSV schema accepted.

### AI-Powered Lead Extraction

- **Two-stage extraction pipeline**: Stage A (mapping planning via function calling) + Stage B (concurrent batch extraction with structured output).
- **Batch size**: 20 rows per request; **concurrency**: 3 simultaneous Gemini requests; **max retries**: 3 with exponential backoff.
- **Authoritative server-side skip rule**: A row is skipped if and only if both `email` and `mobile` are null/empty — the AI's skip advisory is overridden deterministically.
- **Row count invariance**: `inputCount == validCount + skippedCount + failedCount`. Missing rows are detected and flagged.

### Gemini Function Calling & Tool Orchestration

- **Native multi-turn function calling** using `@google/genai` SDK v3 with `AUTO` tool mode.
- **Three registered tools**: `get_crm_schema`, `retrieve_mapping_examples`, `validate_mapping`.
- **Strict allowlist**: Unknown tool names fail immediately with `ALLOWLIST_REJECTION`.
- **Bounded orchestration**: Max 5 tool calls and 3 conversation rounds per import.
- **Safe fallback**: On timeout or Gemini unavailability, falls back to heuristic extraction with `fallbackOccurred: true` telemetry flag.

### Human-in-the-Loop Approval Workflow

- **Atomic conditional updates** prevent race conditions: `updateMany({ where: { status: 'PENDING' } })`.
- **Mutual exclusivity**: Simultaneous approve + reject — exactly one succeeds; the other receives HTTP 400 conflict.
- **Server-side Zod revalidation** at approval time — a second independent validation pass before any CRM write.
- **Idempotent endpoints**: Repeated approve/reject on an already-committed import returns HTTP 200 without duplicate records.
- **Double-click protection**: Frontend buttons disable on first click with loading state.

### Lead Management

- `GET /api/leads` with pagination, search (by name/email/phone), and sorting.
- Full CRM field set: name, email, country code, mobile, company, city, state, country, lead owner, CRM status, CRM note, data source, possession timeline, description.
- `createdAt` date normalization: AI normalizes varied date formats (DD-MM-YYYY, MM/DD/YYYY, natural language) to ISO 8601.

### Real-Time Processing Updates

- **Server-Sent Events (SSE)** stream from `POST /api/extract` response body.
- **Three event types**: `progress` (per batch stats), `complete` (final `pendingImportId`), `error` (recoverable error message).
- **SSE integrity check**: Frontend verifies receipt of a valid `pendingImportId` before transitioning to review; malformed extractions show a recoverable error alert.

### Authentication & Authorization

- **Google OAuth 2.0 / OpenID Connect** with PKCE (`S256` code challenge), exact nonce verification, and durable state store in `oauth_states` PostgreSQL table.
- **Single-owner identity pinning** via `OWNER_GOOGLE_EMAIL` (and optional `OWNER_GOOGLE_SUB`).
- **Server-side sessions** using cryptographically random 256-bit opaque tokens in `HttpOnly`, `SameSite=Lax`, `Secure` cookies.
- **Empty public read-only mode**: Unauthenticated visitors see zero synthetic CRM records.

### Data Validation & Integrity

- **Strict Zod schemas** (`.strict()`) reject unexpected AI-returned fields.
- **No silent coercion**: Malformed values (bad email, bad mobile, invalid enum) go to `failed` with specific error reasons — never silently nulled.
- **Mandatory fields**: `name` required; `email`, `countryCode`, `mobile`, `crmStatus`, `dataSource` nullable with format validation.
- **Enum validation**: `crm_status` and `data_source` accept only declared enum values.

---

## 9. Technology Stack

### Frontend

| Package | Version | Purpose |
|---|---|---|
| `next` | ^16.2.10 | React full-stack framework (App Router) |
| `react` / `react-dom` | ^18.3.1 | UI rendering |
| `typescript` | ^5.7.2 | Static typing |
| `tailwindcss` | ^3.4.16 | Utility-first CSS |
| `@tanstack/react-virtual` | ^3.10.9 | Virtualized row rendering |
| `papaparse` | ^5.4.1 | Client-side CSV parsing |
| `react-dropzone` | ^14.3.5 | Drag-and-drop file upload |
| `lucide-react` | ^0.468.0 | Icon library |
| `clsx` | ^2.1.1 | Conditional className utility |
| `date-fns` | ^3.6.0 | Date formatting |

### Backend

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.21.2 | HTTP server framework |
| `typescript` | ^5.7.2 | Static typing |
| `multer` | ^1.4.5-lts.1 | Multipart file upload middleware |
| `csv-parse` | ^5.5.6 | CSV streaming parser |
| `p-limit` | ^3.1.0 | Concurrency limiter for batch AI calls |
| `zod` | ^3.23.8 | Runtime schema validation |
| `express-async-errors` | ^3.1.1 | Async error propagation |
| `dotenv` | ^16.4.7 | Environment variable loading |

### AI & LLM Integration

| Package | Version | Purpose |
|---|---|---|
| `@google/genai` | ^3.6.1 | Google Gen AI SDK (Gemini 2.5 Flash) |
| `google-auth-library` | ^11.3.4 | Google ID token verification for OAuth |

**Gemini Model**: `gemini-2.5-flash` (configurable via `GEMINI_MODEL` env var)

### Database & ORM

| Technology | Version | Purpose |
|---|---|---|
| PostgreSQL | 15+ | Primary relational database |
| `@prisma/client` | ^5.22.0 | Type-safe database client |
| `prisma` | ^5.22.0 | Schema management and migrations |

### Authentication & Security

| Technology | Purpose |
|---|---|
| Google OAuth 2.0 / OpenID Connect | Identity provider |
| PKCE (`S256`) | Authorization code security |
| Server-side sessions (PostgreSQL) | Stateful session management |
| HttpOnly + SameSite=Lax cookies | XSS-resistant session transport |
| CSRF origin check | State-changing request protection |
| Zod strict schemas | Input validation |
| PII log sanitizer | Regex-based log redaction |

### DevOps & Infrastructure

| Technology | Purpose |
|---|---|
| Docker + Docker Compose | Containerized multi-service deployment |
| GitHub Actions | CI pipeline (test + build on push/PR) |
| Node.js 20 | Runtime environment |

### Testing & Quality Assurance

| Package | Version | Purpose |
|---|---|---|
| `jest` | ^29.7.0 | Test runner (backend + frontend) |
| `ts-jest` | ^29.2.5 | TypeScript transformer for Jest |
| `@testing-library/react` | ^16.1.0 | React component testing utilities |
| `@testing-library/jest-dom` | ^6.6.3 | Custom DOM matchers |
| `jest-environment-jsdom` | ^29.7.0 | Browser-like test environment |

---

## 10. State Machine Specification

### Import Lifecycle

Pending imports follow a strict, non-reversible state machine. Every state transition is backed by an atomic database conditional update.

### State Definitions

| State | Description |
|---|---|
| `PENDING` | Newly extracted and staged import waiting for human review. |
| `APPROVED` | Atomically claimed by approval handler during transaction processing. |
| `COMMITTED` | Successfully persisted into final `imports`, `leads`, and `skipped_rows` tables. |
| `REJECTED` | Explicitly rejected by human reviewer. Staged PII purged immediately. |
| `EXPIRED` | TTL (default 24 hours) exceeded. Cannot be approved or committed. |

### State Transition Rules

| From | To | Trigger | Condition |
|---|---|---|---|
| `PENDING` | `APPROVED` | `POST /api/imports/:id/approve` | `status == PENDING` (atomic) |
| `APPROVED` | `COMMITTED` | Prisma `$transaction` success | Write to `imports`, `leads`, `skipped_rows` |
| `APPROVED` | `PENDING` | Prisma `$transaction` rollback | DB error — rollback resets status |
| `PENDING` | `REJECTED` | `POST /api/imports/:id/reject` | `status == PENDING` (atomic) |
| `PENDING` | `EXPIRED` | TTL cleanup service | `expiresAt < now()` |
| `COMMITTED` | *(terminal)* | — | Idempotent re-approve returns existing import |
| `REJECTED` | *(terminal)* | — | Idempotent re-reject returns existing status |
| `EXPIRED` | *(terminal)* | — | Cannot approve; scheduled cleanup deletes |

### State Transition Diagram

```
                        ┌──────────────┐
                        │   PENDING    │◄─── Rollback (DB error)
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         [Approve]        [Reject]           [TTL]
              │                │                │
              ▼                ▼                ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │ APPROVED │    │ REJECTED │    │ EXPIRED  │
        └────┬─────┘    └──────────┘    └──────────┘
             │          (Terminal)       (Terminal)
             ▼
     [Prisma $transaction]
             │
             ▼
       ┌───────────┐
       │ COMMITTED │
       └───────────┘
        (Terminal)
```

### Failure & Recovery States

- **Transaction Rollback**: If the Prisma `$transaction` fails during approval, the entire operation rolls back and the pending import is **reset to `PENDING`** — no orphaned or partial records.
- **Concurrent Race**: If approve and reject arrive simultaneously, exactly one atomic `updateMany({ where: { status: 'PENDING' } })` succeeds (`count: 1`). The other receives `count: 0` and returns HTTP 400 conflict.
- **Idempotency on `COMMITTED`**: Re-approving a committed import returns the existing `importId` and metadata with HTTP 200 — zero duplicate records created.
- **Idempotency on `REJECTED`**: Re-rejecting returns `{ status: 'REJECTED' }` with HTTP 200.
- **Expired imports**: Cannot be approved; `GET /api/imports/pending/:id` returns HTTP 410 Gone or equivalent error.

---

## 11. AI Integration & Function-Calling Architecture

LeadSync implements **genuine Gemini Function Calling (Tool Use)** — not simulated tool strings or prompt-only engineering. The model dynamically requests backend tools, receives structured execution outputs, reasons across multiple conversation turns, and validates its own proposed mappings before any rows are processed.

### Two-Stage Extraction Architecture

```
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
│ 2. Gemini dynamically invokes tools (e.g. get_crm_schema)              │
│ 3. Backend verifies tool name on allowlist, validates args with Zod    │
│ 4. Backend executes tool and returns { functionResponse }              │
│ 5. Gemini receives tool outputs and reasons over mappings              │
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
│ - Staged in PendingImport (status: PENDING)                            │
│ - Streamed to frontend via Server-Sent Events (SSE)                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
           Human Review ➔ Explicit Owner Approval ➔ Atomic DB Commit
```

### Available Backend Tools

| Tool Name | Parameters | Purpose & Guarantees |
|---|---|---|
| `get_crm_schema` | *None* | Returns all 15 CRM field definitions, types, nullability, and accepted enum values. Read-only. |
| `retrieve_mapping_examples` | `{ headers: string[] }` | Queries a curated alias dictionary (e.g. `Cust_Name` → `name`, `Mob no` → `mobile_without_country_code`). Deterministic — no hallucinated mappings. |
| `validate_mapping` | `{ mappings: [{ source, target }] }` | Server validates proposed mappings: rejects non-existent targets, detects conflicts and missing sources, checks contact coverage. |

### Technique Comparison

| Technique | How LeadSync Uses It |
|---|---|
| **Prompt Engineering** | System instructions define extraction rules, date normalization, and CRM domain context. |
| **Structured Output** | Stage B — Gemini outputs strict JSON array conforming to 15 CRM target fields. |
| **Native Function Calling** | Stage A — model dynamically calls `get_crm_schema`, `retrieve_mapping_examples`, `validate_mapping` across multiple turns. |
| **Deterministic Alias Lookup** | Tool 2 uses token-matched alias dictionary — no hallucinated field mappings. |
| **Advanced RAG** | Deliberately omitted in this phase; pure function-calling approach. |

---

## 12. LLM Usage, Token Tracking & Cost Observability

LeadSync integrates structured telemetry tracking via [`toolObservability.service.ts`](backend/src/services/toolObservability.service.ts) and [`geminiPricing.service.ts`](backend/src/services/geminiPricing.service.ts) to monitor Gemini behavior and estimate API cost per import.

### Metrics Collected

| Metric | Description |
|---|---|
| `totalModelRequests` | Total HTTP exchanges with Gemini API |
| `conversationRounds` | Multi-turn tool call rounds completed |
| `toolCallsRequested` | Names and count of tools requested by the model |
| `toolCallsExecuted` | Tools actually dispatched and executed |
| `toolCallsFailed` | Tools rejected due to invalid args or limit breach |
| `toolExecutionTimesMs` | Exact latency per tool call in milliseconds |
| `tokenUsage.promptTokens` | Prompt tokens consumed (via `usageMetadata`) |
| `tokenUsage.candidatesTokens` | Generated/output tokens consumed |
| `tokenUsage.totalTokens` | Total tokens per import |
| `fallbackOccurred` | Whether heuristic fallback was triggered |

### AI Usage Summary

Token usage and estimated cost per import are stored in the `aiUsage` JSON column of the `Import` model and surfaced in the `AIUsageSummaryCard.tsx` frontend component.

### PII-Safe Logging

All observability log output passes through [`sanitizer.ts`](backend/src/lib/sanitizer.ts):

```
[ToolObservability] Completed in 842ms | Requests: 3 | Rounds: 3 | Tools Called: 2 (retrieve_mapping_examples, validate_mapping) | Executed: 2 | Failed: 0 | Fallback: false
```

No customer PII, raw CSV row content, or secrets appear in any log line.

### Audit Log Event Types

| Event | Trigger |
|---|---|
| `tool_execution_started` | Before executing a registered backend tool |
| `tool_execution_succeeded` | After successful tool execution (with duration) |
| `tool_execution_failed` | On tool failure (with error code and category) |
| `import_approval_started/succeeded/failed` | During human approval lifecycle |
| `import_rejection_started/succeeded/failed` | During human rejection lifecycle |

Audit events include `correlationId` (request-scoped), `importId`, `durationMs`, `retryCount`, and `orchestrationRound` for full lifecycle traceability.

---

## 13. API Reference

### Authentication Endpoints

#### `GET /api/auth/google`
Initiates Google OAuth 2.0 flow with PKCE code challenge and durable signed state/nonce.
- **Response**: `302 Redirect` → Google Accounts login page.

#### `GET /api/auth/google/callback`
Validates OAuth authorization code, verifies PKCE code verifier and exact nonce, inspects ID token signature, enforces single-owner allowlist, and sets `leadsync_session` cookie.
- **Response**: `302 Redirect` → frontend (or `?auth_error=unauthorized` on failure).

#### `GET /api/auth/me`
Returns authenticated owner session status.
- **Response (authenticated)**: `200 OK` — `{ authenticated: true, user: { email, name, picture } }`
- **Response (unauthenticated)**: `200 OK` — `{ authenticated: false, user: null }`

#### `POST /api/auth/logout`
Revokes active session in PostgreSQL and clears `leadsync_session` cookie.
- **Auth**: `leadsync_session` cookie
- **Response**: `200 OK` — `{ success: true }`

---

### Import & Extraction Endpoints

#### `POST /api/extract`
Uploads a CSV file and streams AI extraction results via Server-Sent Events (SSE).
- **Auth**: `leadsync_session` cookie (owner required)
- **Body**: `multipart/form-data` — `file: <CSV file>`
- **Response**: `text/event-stream` SSE stream

**SSE Event Payloads:**

| Event | Payload |
|---|---|
| `progress` | `{ type: "progress", batchIndex, totalBatches, batchRecords, batchSkipped, batchFailed }` |
| `complete` | `{ type: "complete", pendingImportId, totalValid, totalSkipped, totalFailed }` |
| `error` | `{ type: "error", message }` |

#### `GET /api/imports/pending/:id`
Retrieves a staged pending import by ID for human review.
- **Auth**: `leadsync_session` cookie (owner required)
- **Response**: `200 OK` — `PendingImportDTO` with records, skipped, failed, stats
- **Error**: `404 Not Found` if ID not found; `410 Gone` if expired

---

### Approval & Rejection Endpoints

#### `POST /api/imports/:id/approve`
Atomically claims and commits a pending import to production PostgreSQL tables.
- **Auth**: `leadsync_session` cookie (owner required)
- **Flow**: Conditional `PENDING → APPROVED` → Zod revalidation → Prisma `$transaction` → `COMMITTED` → PII purge
- **Response**: `200 OK` — `{ message, importId, totalImported, totalSkipped }`
- **Error**: `400` if already approved/rejected by another request (race condition conflict)
- **Idempotent**: Returns existing import metadata if already `COMMITTED`

#### `POST /api/imports/:id/reject`
Atomically rejects a pending import and immediately purges staged PII.
- **Auth**: `leadsync_session` cookie (owner required)
- **Response**: `200 OK` — `{ message, pendingImportId, status: "REJECTED" }`
- **Idempotent**: Returns `{ status: 'REJECTED' }` if already rejected

---

### Lead Management Endpoints

#### `GET /api/leads`
Retrieves CRM leads with search, pagination, and sorting.
- **Auth**: `leadsync_session` cookie (owner required)
- **Query params**: `page`, `pageSize`, `search`, `sortBy`, `sortOrder`
- **Response**: `200 OK` — `{ leads: Lead[], total: number, page: number, pageSize: number }`

---

### Streaming / SSE Endpoints

#### `POST /api/imports/cleanup`
Maintenance endpoint: purges staged PII for expired pending imports and deletes stale records older than 7 days.
- **Auth**: `leadsync_session` cookie (owner required)
- **Response**: `200 OK` — `{ message, purgedCount, deletedCount }`

> [!NOTE]
> All protected endpoints require a valid `leadsync_session` cookie. Requests from unauthorized Google accounts receive HTTP `403`. Unauthenticated requests receive HTTP `401`.

---

## 14. Database Schema & Data Model

### Entity Relationship Diagram

```
┌─────────────────────┐         ┌─────────────────────┐
│   pending_imports   │         │       imports        │
│─────────────────────│         │─────────────────────│
│ id (PK, cuid)       │────────►│ id (PK, cuid)        │
│ userId              │  1:0..1 │ userId               │
│ filename            │         │ filename             │
│ totalRows           │         │ totalRows            │
│ status (enum)       │         │ totalImported        │
│ records (JSON)      │         │ totalSkipped         │
│ skipped (JSON)      │         │ createdAt            │
│ failed (JSON)       │         │ aiUsage (JSON)       │
│ aiUsage (JSON)      │         └────────┬────────────┘
│ expiresAt           │                  │
│ committedImportId   │         ┌────────▼────────────┐
└─────────────────────┘         │        leads         │
                                │─────────────────────│
┌─────────────────────┐         │ id (PK, cuid)        │
│      sessions       │         │ importId (FK)        │
│─────────────────────│         │ name                 │
│ id (PK, cuid)       │         │ email                │
│ sessionToken        │         │ countryCode          │
│ googleSub           │         │ mobileWithoutCountryCode │
│ email               │         │ company              │
│ name                │         │ city / state / country│
│ picture             │         │ leadOwner            │
│ expiresAt           │         │ crmStatus            │
└─────────────────────┘         │ crmNote              │
                                │ dataSource           │
┌─────────────────────┐         │ possessionTime       │
│    oauth_states     │         │ description          │
│─────────────────────│         │ createdAt / importedAt│
│ id (PK, cuid)       │         └─────────────────────┘
│ state (unique)      │
│ nonce               │         ┌─────────────────────┐
│ codeVerifier        │         │    skipped_rows      │
│ expiresAt           │         │─────────────────────│
└─────────────────────┘         │ id (PK, cuid)        │
                                │ importId (FK)        │
                                │ rawRow (JSON)        │
                                │ reason               │
                                └─────────────────────┘
```

### Model Relationships

| Relationship | Type | Details |
|---|---|---|
| `Import` → `Lead` | One-to-Many | `onDelete: Cascade` — deleting an import removes all its leads |
| `Import` → `SkippedRow` | One-to-Many | `onDelete: Cascade` |
| `PendingImport` → `Import` | One-to-One (optional) | `committedImportId` FK, `onDelete: SetNull` |

### Data Constraints & Indexes

| Model | Index |
|---|---|
| `Import` | `@@index([userId])` |
| `Lead` | `@@index([importId])`, `@@index([email])` |
| `SkippedRow` | `@@index([importId])` |
| `PendingImport` | `@@index([status])`, `@@index([expiresAt])`, `@@index([userId])` |
| `Session` | `@@index([sessionToken])`, `@@index([expiresAt])` |
| `OAuthState` | `@@index([state])`, `@@index([expiresAt])` |

**Enum**: `PendingImportStatus { PENDING, APPROVED, COMMITTED, REJECTED, EXPIRED }`

---

## 15. Security Architecture

### Authentication & Session Management

- **Google OAuth 2.0 / OpenID Connect** with authorization code flow.
- **PKCE (`S256`)**: `code_verifier` and `code_challenge` generated per login attempt. Verifier stored in `OAuthState` table (PostgreSQL-backed, persists across server restarts).
- **Nonce Verification**: Exact nonce cryptographically validated against the returned Google ID token to prevent replay attacks.
- **Server-Side Sessions**: Cryptographically random 256-bit opaque tokens stored in `sessions` table. No JWTs in `localStorage`.
- **Cookie Security**: `HttpOnly` (XSS-resistant), `SameSite=Lax` (CSRF mitigation), `Secure` in production.
- **Session Expiry**: Sessions expire server-side. Expired sessions are rejected by the auth middleware.

### Authorization & Access Control

- **Single-Owner Allowlist**: `OWNER_GOOGLE_EMAIL` environment variable pins exactly one Google account as the owner. All other Google accounts receive HTTP 403 on the OAuth callback.
- **Optional Subject Pinning**: `OWNER_GOOGLE_SUB` pins the immutable Google subject identifier for cryptographic identity binding — robust against email address reuse or account takeover.
- **Role Check in Tools**: Tool registry enforces `user.role === 'owner'` before executing any registered tool.
- **Import Ownership**: Tool execution validates that the requesting user owns the pending import — prevents User A from accessing User B's staged data (`UNAUTHORIZED_TOOL_EXECUTION`).

### CSRF Protection

- State-changing requests (`POST`, `PUT`, `DELETE`) are verified against allowed frontend origins configured via `APP_ORIGIN` and `FRONTEND_URL` environment variables, plus localhost for development.
- OAuth state parameter validated against the `OAuthState` PostgreSQL record — stateless CSRF attacks cannot forge a valid state.

### Input Validation & Sanitization

- **Zod strict schemas** on all API inputs: file uploads, tool arguments, extracted row structures, approval/rejection request bodies.
- **Tool argument validation**: Every tool's arguments parsed with `.strict()` Zod schemas before execution — rogue properties cause immediate `INVALID_TOOL_ARGUMENTS` rejection.
- **CSV prompt encapsulation**: Source CSV column headers and values are passed strictly as data parameters, never as system prompt content — defending against prompt injection.

### Data Privacy & PII Protection

- **Log sanitizer** (`backend/src/lib/sanitizer.ts`): Regex patterns strip emails (`[REDACTED_EMAIL]`), phone numbers (`[REDACTED_PHONE]`), Gemini API keys (`[REDACTED_GEMINI_KEY]`), and Bearer tokens (`Bearer [REDACTED_TOKEN]`) from all log and SSE output.
- **Immediate PII purge on approval**: Upon `COMMITTED`, staged `records`, `skipped`, and `failed` JSON columns in `pending_imports` are set to `[]`.
- **Immediate PII purge on rejection**: Staged JSON arrays purged synchronously on `REJECTED`.
- **24-hour TTL**: Pending imports automatically expire. `cleanupExpiredPendingImports()` runs periodically to purge PII for expired imports and delete stale records older than 7 days.
- **No PII in final CRM writes**: The only PII reaching `leads` table is what the owner explicitly approved.

---

## 16. Reliability & Error Handling

### Retry Mechanisms

Stage B batch extraction uses bounded exponential backoff for transient Gemini API failures:

- **Max retries**: 3 (configurable via `BATCH_MAX_RETRIES` env var)
- **Backoff strategy**: Exponential delay between attempts
- **Transient vs. permanent**: Only transient errors (network timeouts, rate limits, 5xx) trigger retry; validation errors and 4xx responses fail fast without retry.

### Timeout Handling

- **Tool orchestration timeout**: `Promise.race()` with `AbortController` and `AbortSignal`, default `timeoutMs: 10000` per tool call.
- **Stage B abort**: `AbortSignal` passed to `generateContent` calls via `config.abortSignal` — prevents zombie requests on SSE disconnect.
- **Fallback on timeout**: Tool orchestration timeout triggers safe heuristic fallback with `fallbackOccurred: true`.

### Idempotency

- **Approval idempotency**: Re-approving a `COMMITTED` import returns the existing `importId` and stats with HTTP 200 — zero duplicate records.
- **Rejection idempotency**: Re-rejecting a `REJECTED` import returns `{ status: 'REJECTED' }` with HTTP 200.
- **Cleanup idempotency**: `POST /api/imports/cleanup` is safe to call repeatedly — expired records are only purged once.

### Transaction Management

- **Prisma `$transaction`**: Approval commits `Import`, all `Lead` records, and all `SkippedRow` records atomically.
- **All-or-nothing**: Any failure rolls back all three writes. The `pending_imports` status is reset to `PENDING` via error handling after rollback.
- **Staged PII purge inside transaction**: The JSON column wipe is part of the same transaction — either all data is committed and staging cleared, or nothing is written.

### Concurrency & Race Condition Handling

- **Atomic conditional updates**: `prisma.pendingImport.updateMany({ where: { id, status: 'PENDING' }, data: { status: '...' } })` — the `count` result reveals whether the transition succeeded.
- **Mutual exclusivity**: Simultaneous approve + reject — exactly one `updateMany` returns `count: 1`. The other returns `count: 0` and receives HTTP 400 conflict.
- **Concurrent batch isolation**: `p-limit` controls the concurrency of AI batch requests (default: 3 concurrent). Each batch is independently processed — batch failure does not block other batches.

### Graceful Failure & Recovery

- `express-async-errors` propagates all async route errors to the Express error handler — no unhandled promise rejections.
- Tool execution failures are logged with error codes (`UNKNOWN_TOOL`, `INVALID_TOOL_ARGUMENTS`, `TOOL_CALL_LIMIT_EXCEEDED`) and trigger fallback, never a crash.
- Logger failures are silently swallowed — observability code never throws into business logic.

---

## 17. Real-Time Communication Architecture

LeadSync uses **Server-Sent Events (SSE)** for unidirectional real-time streaming from the backend to the browser during AI extraction.

### SSE Implementation Details

- **Endpoint**: `POST /api/extract` — the response body is a `text/event-stream` stream.
- **Headers set by backend**:
  ```
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive
  X-Accel-Buffering: no
  ```
- **Response flushing**: Each event is flushed immediately with `res.write()` and `res.flush()` (if supported by the response object).
- **Event format**: Standard SSE `data: <JSON>\n\n` lines.

### Event Flow

```
Browser                                 Backend
   │                                       │
   │── POST /api/extract (file upload) ───►│
   │                                       │  Stage A: Gemini Function Calling
   │◄── data: { type: "progress", ... } ───│  (Batch 1 complete)
   │◄── data: { type: "progress", ... } ───│  (Batch 2 complete)
   │◄── data: { type: "progress", ... } ───│  (Batch N complete)
   │◄── data: { type: "complete", pendingImportId } ──│
   │                                       │
   │  (SSE connection closes naturally)    │
```

### Frontend SSE Handling

- `CSVImporter.tsx` reads the streaming response incrementally using `ReadableStream` from the Fetch API.
- Each `data:` line is parsed as JSON and dispatched to update extraction progress UI.
- On `complete` event: `pendingImportId` is captured and the component transitions to `ReviewStep.tsx`.
- On `error` event: A recoverable error alert is shown without crashing the UI.
- **SSE integrity check**: Missing or malformed `pendingImportId` in the `complete` event shows an error rather than navigating to a blank review screen.

---

## 18. Performance & Scalability

| Concern | Solution |
|---|---|
| **Large CSV parsing** | Server-side streaming via `csv-parse` — does not load entire file into memory at once |
| **AI throughput** | Concurrent batch processing: 3 simultaneous Gemini requests (configurable `BATCH_CONCURRENCY`) |
| **Frontend virtualization** | `@tanstack/react-virtual` with dynamic row measurement — 60fps scrolling over thousands of extracted rows |
| **Database indexes** | Strategic indexes on `importId`, `email`, `status`, `expiresAt`, `sessionToken` |
| **Connection pooling** | Prisma's built-in connection pool for PostgreSQL |
| **Batch size tuning** | `BATCH_SIZE` env var (default 20) — tunable per deployment for throughput vs. cost tradeoff |
| **PII cleanup** | Automatic TTL expiry + scheduled cleanup prevents unbounded growth of `pending_imports` table |
| **Stateless backend** | Sessions stored in PostgreSQL — backend is horizontally scalable behind a load balancer |

> [!TIP]
> For large CSVs (1,000+ rows) in production, use a paid Gemini API tier to avoid rate limit throttling. Set `BATCH_CONCURRENCY=5` and `BATCH_SIZE=25` for higher throughput.

---

## 19. Observability & Logging

| Component | File | Purpose |
|---|---|---|
| Tool Observability | [`toolObservability.service.ts`](backend/src/services/toolObservability.service.ts) | Tracks tool call metrics, timing, rounds, fallback flag |
| Audit Logger | [`auditLogger.service.ts`](backend/src/services/auditLogger.service.ts) | Structured JSON audit events with correlation IDs |
| PII Sanitizer | [`sanitizer.ts`](backend/src/lib/sanitizer.ts) | Regex-based redaction of emails, phones, API keys, tokens |
| Gemini Pricing | [`geminiPricing.service.ts`](backend/src/services/geminiPricing.service.ts) | Token usage tracking and cost estimation per import |
| Import Usage Tracker | [`importUsageTracker.ts`](backend/src/services/importUsageTracker.ts) | Aggregates token usage across all batches of a single import |

**Log format**: Clean JSON lines written to `console.info` / `console.error`. No log file rotation required for basic deployment — suitable for aggregation by external log collectors (e.g., Papertrail, Datadog, AWS CloudWatch).

**Correlation ID propagation**: Generated per request and threaded through tool execution → extraction → staging → approval/rejection lifecycle.

---

## 20. Project Directory Structure

```
GrowEasy/                              ← Monorepo root
├── README.md                          ← This file
├── docker-compose.yml                 ← Multi-service Docker orchestration
├── .gitignore
├── samples/                           ← Test CSV datasets
│   ├── facebook_leads_export.csv
│   ├── google_ads_export.csv
│   ├── realestate_crm_dump.csv
│   └── messy_manual_spreadsheet.csv
├── .github/
│   └── workflows/
│       └── ci.yml                     ← GitHub Actions CI pipeline
│
├── backend/                           ← Express + TypeScript API
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── .env.example
│   ├── prisma/
│   │   ├── schema.prisma              ← Database schema & models
│   │   └── migrations/                ← Prisma migration history
│   └── src/
│       ├── index.ts                   ← Express app entry point
│       ├── types/
│       │   ├── index.ts               ← Shared TypeScript types
│       │   └── observability.ts       ← Telemetry type definitions
│       ├── lib/
│       │   ├── prisma.ts              ← Prisma client singleton
│       │   └── sanitizer.ts           ← PII log redactor
│       ├── middleware/
│       │   └── auth.middleware.ts     ← Session auth middleware
│       ├── routes/
│       │   ├── auth.route.ts          ← OAuth endpoints
│       │   ├── extract.route.ts       ← CSV upload + SSE extraction
│       │   ├── imports.route.ts       ← Approve / reject / cleanup
│       │   ├── leads.route.ts         ← Lead retrieval
│       │   └── parse.route.ts         ← CSV parse utility
│       ├── services/
│       │   ├── aiExtractor.service.ts           ← Stage B: batch extraction
│       │   ├── geminiToolOrchestrator.service.ts ← Stage A: function calling
│       │   ├── importOrchestrator.service.ts    ← Full import pipeline
│       │   ├── csvParser.service.ts             ← CSV row parsing
│       │   ├── validators.service.ts            ← Row validation logic
│       │   ├── zodSchemas.service.ts            ← Zod schema definitions
│       │   ├── auditLogger.service.ts           ← Structured audit logging
│       │   ├── toolObservability.service.ts     ← Tool call telemetry
│       │   ├── geminiPricing.service.ts         ← Token cost estimation
│       │   ├── importUsageTracker.ts            ← Per-import token aggregation
│       │   ├── retention.service.ts             ← Expired import cleanup
│       │   └── tools/
│       │       ├── toolRegistry.ts              ← Allowlist + dispatch
│       │       ├── crmSchema.tool.ts            ← get_crm_schema implementation
│       │       ├── mappingExamples.tool.ts      ← retrieve_mapping_examples impl.
│       │       └── validateMapping.tool.ts      ← validate_mapping implementation
│       ├── evaluation/                          ← Agent reliability evaluation
│       │   ├── runEvaluation.ts                 ← CLI runner
│       │   ├── evaluator.ts                     ← Evaluation engine
│       │   ├── evaluation-metrics.ts            ← Metric computations
│       │   ├── scenarios.ts                     ← 26 curated test scenarios
│       │   └── types.ts                         ← Evaluation type definitions
│       └── __tests__/                           ← Jest test suites
│           ├── aiExtractor.test.ts
│           ├── approvalWorkflow.test.ts
│           ├── auth.test.ts
│           ├── csvParser.test.ts
│           ├── geminiFunctionCalling.test.ts
│           ├── guardrailsAndAuditLog.test.ts
│           ├── importOrchestrator.test.ts
│           ├── llmObservability.test.ts
│           ├── toolIntegrationWorkflow.test.ts
│           ├── tools.test.ts
│           ├── validators.test.ts
│           ├── zodSchemas.test.ts
│           └── agent-evaluation.test.ts
│
└── frontend/                          ← Next.js 16 App Router
    ├── package.json
    ├── Dockerfile
    ├── next.config.ts
    ├── tailwind.config.ts
    ├── tsconfig.json
    ├── public/
    │   └── samples/
    │       └── sample_groweasy.csv    ← Downloadable sample CSV
    └── src/
        ├── app/
        │   ├── layout.tsx             ← Root layout
        │   ├── page.tsx               ← Home / import page
        │   └── globals.css
        ├── components/
        │   ├── CSVImporter.tsx        ← Main import wizard (upload → SSE → review)
        │   ├── Navbar.tsx             ← Google sign-in / user avatar
        │   ├── Sidebar.tsx            ← Navigation sidebar
        │   ├── StepWizard.tsx         ← Multi-step progress indicator
        │   ├── AIUsageSummaryCard.tsx ← Token & cost display
        │   ├── RecentImports.tsx      ← Import history list
        │   ├── DarkModeToggle.tsx     ← Theme switcher
        │   └── ThemeProvider.tsx      ← Dark mode context
        ├── context/
        │   └── AuthContext.tsx        ← Authentication context provider
        ├── lib/
        │   ├── api.ts                 ← Typed API client functions
        │   └── utils.ts               ← Shared utility functions
        ├── types/
        │   └── index.ts               ← Shared TypeScript types
        └── __tests__/                 ← Jest + RTL test suites
            ├── api.test.ts
            ├── authAndPublicMode.test.tsx
            ├── CSVImporterWorkflow.test.tsx
            └── utils.test.ts
```

---

## 21. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 20+ | LTS recommended |
| **npm** | 10+ | Bundled with Node.js 20 |
| **PostgreSQL** | 15+ | Local, Docker, [Neon](https://neon.tech), or [Supabase](https://supabase.com) |
| **Google AI Studio API Key** | — | [Get a key](https://aistudio.google.com/app/apikey) |
| **Google OAuth 2.0 Credentials** | — | [Create in Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| **Docker & Docker Compose** | 24+ | Only required for Docker deployment |
| **Git** | 2+ | For cloning the repository |

**Google Cloud Console Setup** (required for OAuth):
1. Create a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Google+ API** and **OpenID Connect** scopes.
3. Create **OAuth 2.0 Web Application** credentials.
4. Add `http://localhost:4000/api/auth/google/callback` to **Authorized redirect URIs**.

---

## 22. Environment Variables & Configuration

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string (e.g. `postgresql://user:pass@host/db?sslmode=require`) |
| `GEMINI_API_KEY` | **Yes** | — | Google AI Studio Gemini API key |
| `GOOGLE_CLIENT_ID` | **Yes** | — | Google OAuth 2.0 Web Client ID |
| `GOOGLE_CLIENT_SECRET` | **Yes** | — | Google OAuth 2.0 Client Secret |
| `GOOGLE_REDIRECT_URI` | **Yes** | `http://localhost:4000/api/auth/google/callback` | OAuth callback URI (must match Google Console) |
| `OWNER_GOOGLE_EMAIL` | **Yes** | — | Allowlisted owner Google email (single-owner auth) |
| `OWNER_GOOGLE_SUB` | No | — | Optional Google subject ID for cryptographic identity pinning |
| `SESSION_SECRET` | **Yes** | — | Minimum 32-character secret for signing OAuth state cookies |
| `APP_ORIGIN` | No | `http://localhost:3000` | Allowed frontend origin for CSRF and cookie validation |
| `FRONTEND_URL` | No | `http://localhost:3000` | Frontend redirect URL after OAuth callback |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model identifier |
| `PORT` | No | `4000` | Backend server listening port |
| `PENDING_IMPORT_TTL_HOURS` | No | `24` | Hours before a pending import auto-expires |
| `BATCH_SIZE` | No | `20` | Rows per AI extraction batch |
| `BATCH_CONCURRENCY` | No | `3` | Concurrent AI batch requests |
| `BATCH_MAX_RETRIES` | No | `3` | Maximum exponential backoff retry attempts |

### Frontend (`frontend/.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `BACKEND_PROXY_URL` | **Yes** | `http://localhost:4000` | Backend API URL for Next.js server-side API route rewrites |
| `NEXT_PUBLIC_BACKEND_URL` | No | `""` (relative `/api/*`) | Optional browser-side API URL override |

---

## 23. Local Development Setup

### Clone the Repository

```bash
git clone https://github.com/Sayantan-dev1003/LeadSync.git
cd LeadSync
```

### Install Dependencies

```bash
# Install backend dependencies
cd backend
npm ci

# Install frontend dependencies
cd ../frontend
npm ci
```

### Configure Environment Variables

**Backend:**
```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` with your values:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/leadsync"
GEMINI_API_KEY="your-gemini-api-key"
GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-client-secret"
GOOGLE_REDIRECT_URI="http://localhost:4000/api/auth/google/callback"
OWNER_GOOGLE_EMAIL="your-email@gmail.com"
SESSION_SECRET="replace-with-at-least-32-random-characters-here"
```

**Frontend:**
```bash
cd ../frontend
cp .env.example .env.local
```

Edit `frontend/.env.local`:
```env
BACKEND_PROXY_URL=http://localhost:4000
```

### Database Setup & Migrations

```bash
cd backend

# Generate Prisma client types
npx prisma generate

# Apply all migrations to your database
npx prisma migrate deploy

# (Development) Create and apply a new migration after schema changes
npx prisma migrate dev --name <migration_name>

# (Optional) Open Prisma Studio to inspect the database
npx prisma studio
```

### Run the Application

Open two terminals:

**Terminal 1 — Backend:**
```bash
cd backend
npm run dev
# → API running at http://localhost:4000
# → Health check: http://localhost:4000/health
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
# → Next.js running at http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 24. Docker Setup & Deployment

The project ships with multi-stage Dockerfiles and a `docker-compose.yml` for one-command deployment.

### Quick Start

```bash
# 1. Copy and configure environment variables
cp .env.example .env
# Edit .env with your DATABASE_URL, GEMINI_API_KEY, and OAuth credentials

# 2. Build and start both services
docker compose up --build -d

# 3. Apply database migrations
docker compose exec backend npx prisma migrate deploy
```

**Services:**
- **Frontend**: [http://localhost:3000](http://localhost:3000)
- **Backend API**: [http://localhost:4000](http://localhost:4000)
- **Health Check**: [http://localhost:4000/health](http://localhost:4000/health)

### Docker Compose Configuration

```yaml
services:
  backend:
    build: ./backend
    ports: ["4000:4000"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:4000/health"]
      interval: 30s
    restart: unless-stopped

  frontend:
    build: ./frontend
    ports: ["3000:3000"]
    depends_on:
      backend:
        condition: service_healthy
    restart: unless-stopped
```

### Useful Docker Commands

```bash
# View service logs
docker compose logs -f backend
docker compose logs -f frontend

# Stop all services
docker compose down

# Rebuild after code changes
docker compose up --build -d

# Run database migrations in running container
docker compose exec backend npx prisma migrate deploy

# Open Prisma Studio via container
docker compose exec backend npx prisma studio
```

> [!IMPORTANT]
> For Docker deployments, set `GOOGLE_REDIRECT_URI` to your production backend URL (e.g. `https://api.yourdomain.com/api/auth/google/callback`) and update **Authorized redirect URIs** in the Google Cloud Console.

---

## 25. Testing & Quality Assurance

### Unit Tests

Backend unit tests cover individual service functions in isolation using mocked dependencies:
- Zod schema validation edge cases ([`zodSchemas.test.ts`](backend/src/tests/zodSchemas.test.ts))
- Row validation logic and skip rules ([`validators.test.ts`](backend/src/tests/validators.test.ts))
- CSV parser service ([`csvParser.test.ts`](backend/src/tests/csvParser.test.ts))
- Tool registry allowlist and argument validation ([`tools.test.ts`](backend/src/tests/tools.test.ts))

### Integration Tests

Backend integration tests cover multi-service workflows:
- Full approval and rejection lifecycle ([`approvalWorkflow.test.ts`](backend/src/tests/approvalWorkflow.test.ts))
- Import orchestrator pipeline ([`importOrchestrator.test.ts`](backend/src/tests/importOrchestrator.test.ts))
- Tool integration workflow ([`toolIntegrationWorkflow.test.ts`](backend/src/tests/toolIntegrationWorkflow.test.ts))
- Authentication flows ([`auth.test.ts`](backend/src/tests/auth.test.ts))

### API Tests

Frontend API client tests ([`api.test.ts`](frontend/src/tests/api.test.ts)) verify that the typed API client functions correctly serialize requests and handle response shapes.

### AI Evaluation Tests

A dedicated **quantitative agent reliability evaluation framework** (`backend/src/evaluation/`) runs 26 curated scenarios across 4 categories:

| Category | Scenarios | Focus |
|---|---|---|
| **A. Function/Tool Selection Accuracy** | SCN-SEL-01..06 | Correct tool selection for various CSV header types |
| **B. Function Argument Accuracy** | SCN-ARG-01..06 | Argument structure, types, and validation |
| **C. AI Output Validation** | SCN-VAL-01..06 | Zod schema enforcement on AI-generated rows |
| **D. Tool Execution & Recovery** | SCN-REC-01..08 | Retry, fallback, limits, ownership, human boundary |

**Four reliability metrics computed:**
- **Successful Extraction Rate**: `(Successfully Extracted / Total Eligible) × 100`
- **Function-Call Accuracy**: Tool selection + argument accuracy rates
- **Schema Validation Pass Rate**: `(Valid Accepted + Invalid Rejected) / Total × 100`
- **Failure Recovery Rate**: `(Recovered Transient Failures / Total Eligible Transient) × 100`

### Running the Test Suite

```bash
# Backend tests (219 tests, 12 suites)
cd backend
npm test

# Backend tests with coverage report
npm run test:coverage

# Agent evaluation — deterministic CI mode (26 scenarios, zero API cost)
npm run evaluate:agent

# Agent evaluation — live Gemini mode (requires GEMINI_API_KEY)
npm run evaluate:agent:live

# Frontend tests (44 tests, 4 suites)
cd frontend
npm test

# Build verification (TypeScript compile check)
cd backend && npm run build
cd ../frontend && npm run build
```

**Expected output (backend):**
```
Test Suites: 12 passed, 12 total
Tests:       219 passed, 219 total
```

**Expected output (frontend):**
```
Test Suites: 4 passed, 4 total
Tests:       44 passed, 44 total
```

---

## 26. CI/CD Pipeline

LeadSync uses **GitHub Actions** for continuous integration on every push and pull request to `main`/`master`.

### Pipeline: `.github/workflows/ci.yml`

```
Push / Pull Request to main
         │
         ├──► Job 1: Backend Test & Build (ubuntu-latest)
         │       ├── Setup Node.js 20
         │       ├── npm ci
         │       ├── npx prisma generate
         │       ├── npm test  (219 tests)
         │       └── npm run build  (tsc compile)
         │
         └──► Job 2: Frontend Test & Build (ubuntu-latest)
                 ├── Setup Node.js 20
                 ├── npm ci
                 ├── npm test  (44 tests)
                 └── npm run build  (Next.js webpack build)
```

### CI Environment Variables

| Variable | CI Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/groweasy_ci` | Local PostgreSQL in CI |
| `GEMINI_API_KEY` | `test-gemini-api-key` | Tests use mocked Gemini — no live API calls in CI |
| `JWT_SECRET` | Hardcoded CI value | 32+ character test secret |

> [!NOTE]
> CI tests run in **deterministic mock mode** — no real Gemini API calls are made, eliminating cost and flakiness from external service availability.

---

## 27. Production Deployment Guide

### Recommended Stack

| Component | Recommendation |
|---|---|
| **Backend hosting** | Railway, Render, Fly.io, AWS ECS, Google Cloud Run |
| **Frontend hosting** | Vercel (native Next.js support), Netlify |
| **Database** | Neon (serverless PostgreSQL), Supabase, AWS RDS |
| **Domain & TLS** | Cloudflare, Let's Encrypt (auto via platform) |

### Production Checklist

```bash
# 1. Set all required environment variables in your hosting platform

# 2. Set NODE_ENV=production
NODE_ENV=production

# 3. Use a strong SESSION_SECRET (min 32 chars, cryptographically random)
openssl rand -base64 32

# 4. Update GOOGLE_REDIRECT_URI to your production backend URL
GOOGLE_REDIRECT_URI=https://api.yourdomain.com/api/auth/google/callback

# 5. Set APP_ORIGIN and FRONTEND_URL to your production frontend URL
APP_ORIGIN=https://yourdomain.com
FRONTEND_URL=https://yourdomain.com

# 6. Apply migrations in production
npx prisma migrate deploy

# 7. Build and start the backend
npm run build
npm start  # Runs: node dist/index.js

# 8. Build and start the frontend
npm run build
npm start  # Runs: next start
```

### Database Migration in Production

```bash
# Never use migrate dev in production
npx prisma migrate deploy   # Applies committed migrations only
npx prisma generate         # Regenerates Prisma client after migration
```

### Security Hardening for Production

- Use `Secure` cookie flag (set automatically when `NODE_ENV=production`).
- Restrict PostgreSQL access to backend IP only; use SSL (`sslmode=require` in `DATABASE_URL`).
- Rotate `SESSION_SECRET` and `GEMINI_API_KEY` via your platform's secret manager.
- Set `OWNER_GOOGLE_SUB` for immutable subject pinning once you have your Google sub ID.
- Configure `PENDING_IMPORT_TTL_HOURS=24` and schedule `POST /api/imports/cleanup` via a cron job.

---

## 28. Screenshots & Application Preview

> Screenshots and application previews will be added here. The application features:

| Screen | Description |
|---|---|
| **Home / Upload** | Full-width drag-and-drop CSV upload zone with PapaParse column preview |
| **Extraction Progress** | Real-time SSE-driven batch progress with batch counters and status breakdown |
| **Review Screen** | Virtualized table with expandable row details, CRM status pills, and source badges |
| **Approval Confirmation** | Atomic commit confirmation with import stats (imported, skipped, failed) |
| **Manage Leads** | Paginated, searchable CRM leads table with full field display |
| **AI Usage Summary** | Token usage card with prompt tokens, candidate tokens, and estimated cost |
| **Public Portfolio Mode** | Empty state portfolio view for unauthenticated visitors |

---

## 29. Demo & Usage Guide

### Walkthrough with Sample CSVs

Four test datasets are available in `/samples/`:

| File | Description | AI Challenge |
|---|---|---|
| `facebook_leads_export.csv` | Standard Facebook Leads format: `full_name`, `phone_number`, ad metadata | Minimal tool calls; standard headers |
| `google_ads_export.csv` | Google Ads export: `Customer Name`, combined `Location`, campaign columns | Location parsing; irrelevant column filtering |
| `realestate_crm_dump.csv` | Dual mobile columns, `DD-MM-YYYY` dates, enum values | Date normalization; dual contact resolution |
| `messy_manual_spreadsheet.csv` | Header typos (`Emal`, `staus`, `Mob_No`), ambiguous status values | Maximum tool calls; alias resolution via `retrieve_mapping_examples` |

### Step-by-Step Demo

1. **Sign in** with your configured owner Google account.
2. **Upload** `samples/messy_manual_spreadsheet.csv` using the dropzone.
3. **Watch the SSE stream**: Observe batch progress as Gemini resolves `Mob_No → mobile_without_country_code`, `Emal → email`, `staus → crm_status`.
4. **Review the AI output**: Expand rows to verify CRM field mapping quality.
5. **Approve the import**: Click **Approve & Import** — observe the atomic commit confirmation.
6. **Navigate to Manage Leads**: Browse the committed CRM records.
7. **Try rejection**: Upload another CSV and click **Reject Import** — confirm zero records were written.

### Testing the Tool Call Trace

Inspect the backend console during messy CSV processing for the tool observability summary:
```
[ToolObservability] Completed in 842ms | Requests: 3 | Rounds: 3 | Tools Called: 2 (retrieve_mapping_examples, validate_mapping) | Executed: 2 | Failed: 0 | Fallback: false
```

---

## 30. Troubleshooting

### Common Issues

**`DATABASE_URL` connection error**
```
Error: Can't reach database server
```
- Verify PostgreSQL is running and accessible from the backend.
- Check `DATABASE_URL` format: `postgresql://user:password@host:5432/dbname`.
- For cloud databases, ensure SSL: `?sslmode=require`.
- Run `npx prisma db push` to verify connectivity.

**`GEMINI_API_KEY` invalid or quota exceeded**
```
Error: 403 Forbidden / RESOURCE_EXHAUSTED
```
- Verify the key at [aistudio.google.com](https://aistudio.google.com).
- Free tier has request-per-minute limits. Retry after 60 seconds.
- For large CSVs, use a paid API tier key.

**OAuth redirect URI mismatch**
```
Error 400: redirect_uri_mismatch
```
- The `GOOGLE_REDIRECT_URI` in `.env` must exactly match one of the **Authorized redirect URIs** in the Google Cloud Console.
- For local dev: `http://localhost:4000/api/auth/google/callback`.

**Prisma client not generated**
```
Error: Cannot find module '@prisma/client'
```
```bash
cd backend && npx prisma generate
```

**SSE stream not receiving events in browser**
- Ensure no proxy or middleware is buffering the response (disable `X-Accel-Buffering` for nginx).
- Check browser DevTools → Network → `extract` → EventStream tab.
- Verify CORS is configured for your frontend origin in the backend.

**Frontend `NEXT_PUBLIC_BACKEND_URL` not set**
```
TypeError: Failed to fetch
```
- Ensure `frontend/.env.local` contains `BACKEND_PROXY_URL=http://localhost:4000`.
- Restart the Next.js dev server after changing `.env.local`.

**Tests failing with mock errors**
```bash
# Regenerate Prisma client before running tests
cd backend && npx prisma generate && npm test
```

---

## 31. Known Limitations

- **Single-Owner Architecture**: LeadSync is specifically designed as a single-owner portfolio application. Multi-user, multi-tenant CRM workflows are not supported in the current architecture.
- **Gemini Rate Limits**: Free-tier Gemini API has request-per-minute (RPM) and token-per-minute (TPM) limits. Large CSVs (1,000+ rows) will be throttled; production deployments should use a paid API tier.
- **Ambiguous Data Source**: The AI intentionally abstains from guessing `data_source` if the CSV does not contain clear project-name signals — it returns `null` rather than hallucinating a source.
- **No File Size Streaming**: Files are buffered by `multer` before parsing begins. Very large files (100 MB+) may cause memory pressure. Stream-based upload handling is a future enhancement.
- **No Multi-File Import**: Each import session processes one CSV file. Batch multi-file imports are not currently supported.
- **SSE Reconnection**: There is no automatic SSE reconnection on network interruption during extraction. Refreshing the page after a disconnection requires re-uploading the CSV.
- **Enum Extensibility**: `crm_status` and `data_source` enum values are currently hardcoded in the Zod schema and CRM schema tool. Adding new values requires a schema update and migration.
- **No Real-Time Collaboration**: The human review step is single-owner only. Collaborative review workflows (e.g., team approval) are not supported.

---

## 32. Future Enhancements / Roadmap

| Priority | Enhancement | Description |
|---|---|---|
| 🔴 High | **Advanced RAG Mapping** | Replace the curated alias dictionary with vector embeddings and semantic similarity search for far broader alias coverage. |
| 🔴 High | **Streaming File Upload** | Replace `multer` buffering with streaming multipart parsing to support very large CSVs without memory pressure. |
| 🟡 Medium | **Multi-User / Multi-Tenant** | Extend the auth model to support team accounts with role-based access control (admin, reviewer, read-only). |
| 🟡 Medium | **CRM Field Configurability** | Allow the owner to define custom target CRM schemas via UI — dynamic enum values, custom fields. |
| 🟡 Medium | **SSE Reconnection** | Auto-reconnect SSE on network interruption, resuming from the last confirmed batch checkpoint. |
| 🟡 Medium | **Webhook Notifications** | Emit webhooks on import commit/rejection for downstream CRM or Slack integrations. |
| 🟢 Low | **Multi-File Batch Import** | Accept a ZIP of CSVs and process each in parallel with individual review steps. |
| 🟢 Low | **Export to CRM Platforms** | Direct push to HubSpot, Salesforce, or Zoho after human approval — bypassing CSV altogether. |
| 🟢 Low | **Review Screen Editing** | Allow the human reviewer to inline-edit individual field values before approving. |
| 🟢 Low | **Dark Mode Persistence** | Persist dark/light mode preference to `localStorage` across sessions. |
| 🟢 Low | **Admin Dashboard** | Usage analytics dashboard: imports over time, extraction accuracy trends, token cost charts. |

---

## 33. Contributing Guidelines

Contributions are welcome! Please follow these guidelines to maintain code quality and architectural integrity.

### Development Workflow

```bash
# 1. Fork the repository and clone your fork
git clone https://github.com/<your-username>/LeadSync.git
cd LeadSync

# 2. Create a feature branch
git checkout -b feat/your-feature-name

# 3. Install dependencies
cd backend && npm ci
cd ../frontend && npm ci

# 4. Make your changes following the conventions below

# 5. Run the full test suite — all tests must pass
cd backend && npm test
cd ../frontend && npm test

# 6. Run TypeScript compile checks
cd backend && npm run build
cd ../frontend && npm run build

# 7. Commit with a descriptive message
git commit -m "feat: add streaming file upload support"

# 8. Push and open a pull request against main
git push origin feat/your-feature-name
```

### Code Conventions

- **TypeScript strict mode** is enforced. No `any` types without explicit justification.
- **Zod validation** is required for all new API inputs — no raw `req.body` access.
- **PII sanitizer** must be applied to any new log output containing user data.
- **Tests are mandatory** for new services, routes, and tools. Aim for >80% coverage on new code.
- **No direct CRM writes in AI tools** — all tool implementations are strictly read-only. Mutations require human approval via the existing workflow.
- **State machine transitions** must use atomic conditional updates — never unconditional `update`.

### Pull Request Standards

- **Description**: Explain what changed, why, and how it was tested.
- **Tests**: Include unit tests for new logic; integration tests for new workflows.
- **Breaking changes**: Clearly document any API or schema changes in the PR description.
- **Migration**: Include a Prisma migration if the database schema changes.
- **No secrets**: Never commit `.env` files, API keys, or credentials.

### Reporting Issues

- Use GitHub Issues for bug reports, feature requests, and questions.
- Bug reports: Include OS, Node.js version, reproduction steps, and relevant log output (sanitize any PII before pasting).

---

<div align="center">

**Built with ❤️ using Google Gemini, Next.js, Express, and PostgreSQL**

[⬆ Back to Top](#leadsync)

</div>
