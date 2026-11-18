import type { CRMRecord, SkippedRow, ApproveResponse, RejectResponse, PendingImportDTO } from '@/types';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

export interface ExtractProgressEvent {
  type: 'progress';
  batchIndex: number;
  totalBatches: number;
  batchRecords: CRMRecord[];
  batchSkipped: SkippedRow[];
  /** Rows that failed AI extraction or validation — distinct from skipped rows. */
  batchFailed?: Array<{ row: Record<string, string>; reason: string }>;
}

export interface ExtractCompleteEvent {
  type: 'complete';
  pendingImportId?: string;
  totalValid?: number;
  totalImported?: number;
  totalSkipped: number;
  /** Rows that failed AI extraction or validation after all retries. */
  totalFailed?: number;
  importId?: string;
}

export type { ApproveResponse, RejectResponse, PendingImportDTO };

export interface ExtractErrorEvent {
  type: 'error';
  message: string;
}

export type ExtractEvent = ExtractProgressEvent | ExtractCompleteEvent | ExtractErrorEvent;

/**
 * Streams AI extraction results from the backend via fetch + ReadableStream.
 * Calls onEvent for each SSE event as it arrives.
 *
 * Resolves when the stream ends with a 'complete' event.
 * Rejects when:
 *   - The HTTP response is not OK.
 *   - The backend sends an 'error' event.
 *   - The stream ends without a 'complete' event (interrupted stream).
 *
 * This ensures callers cannot accidentally treat a failed or interrupted import
 * as a successful one.
 */
export async function extractLeads(
  file: File,
  onEvent: (event: ExtractEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${BACKEND_URL}/api/extract`, {
    method: 'POST',
    body: formData,
    signal,
  });

  if (!response.ok) {
    let errorMessage = `Server error: ${response.status}`;
    try {
      const errBody = await response.json();
      errorMessage = errBody.error || errorMessage;
    } catch {}
    throw new Error(errorMessage);
  }

  if (!response.body) {
    throw new Error('No response body received from server');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedCompleteEvent = false;
  let errorFromStream: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newlines (SSE event delimiter)
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? ''; // Keep incomplete trailing data

      for (const eventStr of events) {
        const dataLine = eventStr.trim();
        if (dataLine.startsWith('data: ')) {
          const jsonStr = dataLine.slice(6);
          try {
            const event = JSON.parse(jsonStr) as ExtractEvent;
            onEvent(event);

            if (event.type === 'complete') {
              receivedCompleteEvent = true;
            } else if (event.type === 'error') {
              // Store the error; we'll throw after the loop so the reader is released
              errorFromStream = event.message;
            }
          } catch (parseErr) {
            console.warn('Failed to parse SSE event — skipping malformed frame');
          }
        }
      }

      // Stop reading once we've received a terminal event
      if (receivedCompleteEvent || errorFromStream !== null) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Throw after the reader is released so the connection is cleaned up properly
  if (errorFromStream !== null) {
    throw new Error(errorFromStream);
  }

  if (!receivedCompleteEvent) {
    throw new Error('Import stream ended without a completion event — the import may be incomplete');
  }
}

/**
 * Checks backend health.
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Submits explicit human approval to persist the pending import.
 */
export async function approvePendingImport(pendingImportId: string): Promise<ApproveResponse> {
  const response = await fetch(`${BACKEND_URL}/api/imports/${pendingImportId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    let errorMessage = `Approval failed: ${response.status}`;
    try {
      const errBody = await response.json();
      errorMessage = errBody.error || errorMessage;
    } catch {}
    throw new Error(errorMessage);
  }

  return response.json();
}

/**
 * Submits explicit human rejection to discard the pending import without persisting leads.
 */
export async function rejectPendingImport(pendingImportId: string): Promise<RejectResponse> {
  const response = await fetch(`${BACKEND_URL}/api/imports/${pendingImportId}/reject`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    let errorMessage = `Rejection failed: ${response.status}`;
    try {
      const errBody = await response.json();
      errorMessage = errBody.error || errorMessage;
    } catch {}
    throw new Error(errorMessage);
  }

  return response.json();
}

/**
 * Loads pending import details from the server.
 */
export async function getPendingImport(pendingImportId: string): Promise<PendingImportDTO> {
  const response = await fetch(`${BACKEND_URL}/api/imports/pending/${pendingImportId}`);

  if (!response.ok) {
    let errorMessage = `Failed to fetch pending import: ${response.status}`;
    try {
      const errBody = await response.json();
      errorMessage = errBody.error || errorMessage;
    } catch {}
    throw new Error(errorMessage);
  }

  const data = await response.json();
  return data.pendingImport;
}
