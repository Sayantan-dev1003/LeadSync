import type { CRMRecord, SkippedRow, FailedRow, ApproveResponse, RejectResponse, PendingImportDTO } from '@/types';

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_BACKEND_URL || '')
    : (process.env.BACKEND_PROXY_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000');

export function getAuthToken(): string | null {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('leadsync_auth_token');
    if (stored && stored.trim() && stored !== 'demo-reviewer-token') {
      return stored.trim();
    }
  }
  const envToken = process.env.NEXT_PUBLIC_API_TOKEN;
  if (envToken && envToken.trim() && envToken !== 'demo-reviewer-token') {
    return envToken.trim();
  }
  return null;
}

export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  if (!token) return {};
  return {
    Authorization: `Bearer ${token}`,
  };
}

export interface ExtractProgressEvent {
  type: 'progress';
  batchIndex: number;
  totalBatches: number;
  batchRecords: CRMRecord[];
  batchSkipped: SkippedRow[];
  batchFailed?: FailedRow[];
}

export interface ExtractCompleteEvent {
  type: 'complete';
  pendingImportId?: string;
  totalValid?: number;
  totalImported?: number;
  totalSkipped: number;
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
 * Strict validation:
 * - Rejects if complete event lacks a valid pendingImportId.
 * - Rejects if stream ends without complete event.
 * - Attaches authorization headers and credentials.
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
    credentials: 'include',
    headers: {
      ...getAuthHeaders(),
    },
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

            if (event.type === 'complete') {
              if (
                !event.pendingImportId ||
                typeof event.pendingImportId !== 'string' ||
                event.pendingImportId.trim() === ''
              ) {
                errorFromStream = 'Malformed completion event: missing pendingImportId';
                break;
              }
              receivedCompleteEvent = true;
            } else if (event.type === 'error') {
              errorFromStream = event.message;
              break;
            }

            onEvent(event);
          } catch {
            console.warn('Failed to parse SSE event — skipping malformed frame');
          }
        }
      }

      // Stop reading once we've received a terminal event
      if (receivedCompleteEvent || errorFromStream !== null) {
        break;
      }
    }

    // Process any trailing frame left in buffer after stream ends
    if (buffer.trim() && !receivedCompleteEvent && errorFromStream === null) {
      const dataLine = buffer.trim();
      if (dataLine.startsWith('data: ')) {
        const jsonStr = dataLine.slice(6);
        try {
          const event = JSON.parse(jsonStr) as ExtractEvent;
          if (event.type === 'complete') {
            if (
              !event.pendingImportId ||
              typeof event.pendingImportId !== 'string' ||
              event.pendingImportId.trim() === ''
            ) {
              errorFromStream = 'Malformed completion event: missing pendingImportId';
            } else {
              receivedCompleteEvent = true;
            }
          } else if (event.type === 'error') {
            errorFromStream = event.message;
          }
          onEvent(event);
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }

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
    const res = await fetch(`${BACKEND_URL}/health`, {
      credentials: 'include',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Submits explicit human approval to persist the pending import.
 */
export async function approvePendingImport(pendingImportId: string): Promise<ApproveResponse> {
  if (!pendingImportId || typeof pendingImportId !== 'string' || !pendingImportId.trim()) {
    throw new Error('Invalid pending import ID');
  }

  const response = await fetch(`${BACKEND_URL}/api/imports/${pendingImportId}/approve`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
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
  if (!pendingImportId || typeof pendingImportId !== 'string' || !pendingImportId.trim()) {
    throw new Error('Invalid pending import ID');
  }

  const response = await fetch(`${BACKEND_URL}/api/imports/${pendingImportId}/reject`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
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
  if (!pendingImportId || typeof pendingImportId !== 'string' || !pendingImportId.trim()) {
    throw new Error('Invalid pending import ID');
  }

  const response = await fetch(`${BACKEND_URL}/api/imports/pending/${pendingImportId}`, {
    credentials: 'include',
    headers: {
      ...getAuthHeaders(),
    },
  });

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
