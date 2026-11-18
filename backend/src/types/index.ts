// Shared TypeScript types for the GrowEasy CSV Importer

export type RawRow = Record<string, string>;

export const CRM_STATUS_VALUES = [
  'GOOD_LEAD_FOLLOW_UP',
  'DID_NOT_CONNECT',
  'BAD_LEAD',
  'SALE_DONE',
] as const;

export type CrmStatus = (typeof CRM_STATUS_VALUES)[number];

export const DATA_SOURCE_VALUES = [
  'leads_on_demand',
  'meridian_tower',
  'eden_park',
  'varah_swamy',
  'sarjapur_plots',
] as const;

export type DataSource = (typeof DATA_SOURCE_VALUES)[number];

export interface CRMRecord {
  created_at: string | null;
  name: string | null;
  email: string | null;
  country_code: string | null;
  mobile_without_country_code: string | null;
  company: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  lead_owner: string | null;
  crm_status: CrmStatus | null;
  crm_note: string | null;
  data_source: DataSource | null;
  possession_time: string | null;
  description: string | null;
}

export interface AIExtractedRow extends CRMRecord {
  skip?: boolean;
  skipReason?: string | null;
}

/** A row that was deliberately skipped (no contact info). */
export interface SkippedRow {
  row: RawRow;
  reason: string;
}

/** A row that failed due to AI/validation/DB error. */
export interface FailedRow {
  row: RawRow;
  reason: string;
}

export type PendingImportStatus = 'PENDING' | 'COMMITTED' | 'REJECTED' | 'EXPIRED';

export interface PendingImportDTO {
  id: string;
  filename: string;
  totalRows: number;
  status: PendingImportStatus;
  totalValid: number;
  totalSkipped: number;
  totalFailed: number;
  createdAt: string;
  expiresAt: string;
  committedImportId?: string | null;
  records: CRMRecord[];
  skipped: SkippedRow[];
  failed: FailedRow[];
}

export interface BatchResult {
  records: CRMRecord[];
  skipped: SkippedRow[];
  /** Rows that could not be processed due to AI or validation failure. */
  failed: FailedRow[];
}

export interface ImportResult {
  importId?: string;
  records: CRMRecord[];
  skipped: SkippedRow[];
  failed: FailedRow[];
  totalImported: number;
  totalSkipped: number;
  totalFailed: number;
}

export interface SSEProgressEvent {
  type: 'progress';
  batchIndex: number;
  totalBatches: number;
  batchRecords: CRMRecord[];
  batchSkipped: SkippedRow[];
  batchFailed: FailedRow[];
}

export interface SSECompleteEvent {
  type: 'complete';
  pendingImportId?: string;
  totalValid: number;
  totalSkipped: number;
  totalFailed: number;
  totalImported?: number;
  importId?: string;
}

export interface SSEErrorEvent {
  type: 'error';
  message: string;
}

export type SSEEvent = SSEProgressEvent | SSECompleteEvent | SSEErrorEvent;

export interface ParseCSVResult {
  rows: RawRow[];
  headers: string[];
  totalRows: number;
  warnings: string[];
}
