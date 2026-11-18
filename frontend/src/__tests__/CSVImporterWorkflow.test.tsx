/**
 * Tests for the CSVImporter Human-in-the-Loop review and approval workflow.
 *
 * Verifies:
 * - The frontend displays AI-transformed records, not merely the original CSV.
 * - The frontend does NOT navigate to Manage Leads when Gemini extraction finishes.
 * - Navigation to Manage Leads occurs only after explicit human approval and successful persistence.
 * - Rejection confirms no CRM leads were added and does not navigate to Manage Leads.
 * - Approval failures retain the review screen and surface retryable errors without falsely claiming success.
 * - Closing modal does not imply approval.
 */

import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CSVImporter } from '../components/CSVImporter';
import { extractLeads, approvePendingImport, rejectPendingImport } from '../lib/api';
import type { CRMRecord, SkippedRow } from '../types';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

jest.mock('../lib/api', () => ({
  extractLeads: jest.fn(),
  approvePendingImport: jest.fn(),
  rejectPendingImport: jest.fn(),
  getPendingImport: jest.fn(),
}));

// Mock @tanstack/react-virtual to render all rows in JSDOM environment
jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize?: () => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * (options.estimateSize ? options.estimateSize() : 48),
        size: options.estimateSize ? options.estimateSize() : 48,
        key: index,
      })),
    getTotalSize: () => options.count * 48,
  }),
}));

// Mock UploadStep so we can easily simulate CSV file upload and parsing
jest.mock('../components/steps/UploadStep', () => ({
  UploadStep: ({ onParsed }: { onParsed: (data: any, file: File) => void }) => (
    <div data-testid="upload-step">
      <button
        onClick={() => {
          const fakeFile = new File(['Name,Email\nJohn Doe,john@example.com'], 'leads.csv', {
            type: 'text/csv',
          });
          onParsed(
            {
              filename: 'leads.csv',
              headers: ['Name', 'Email'],
              rows: [{ Name: 'John Doe', Email: 'john@example.com' }],
              totalRows: 1,
              warnings: [],
            },
            fakeFile
          );
        }}
      >
        Simulate CSV Upload
      </button>
    </div>
  ),
}));

const mockExtractLeads = extractLeads as jest.MockedFunction<typeof extractLeads>;
const mockApprove = approvePendingImport as jest.MockedFunction<typeof approvePendingImport>;
const mockReject = rejectPendingImport as jest.MockedFunction<typeof rejectPendingImport>;

const sampleExtractedLead: CRMRecord = {
  created_at: '2024-05-13T00:00:00.000Z',
  name: 'John Doe',
  email: 'john@example.com',
  country_code: '+1',
  mobile_without_country_code: '4155551234',
  company: 'Acme Corp',
  city: 'San Francisco',
  state: 'CA',
  country: 'USA',
  lead_owner: 'Alice',
  crm_status: 'GOOD_LEAD_FOLLOW_UP',
  crm_note: null,
  data_source: 'leads_on_demand',
  possession_time: null,
  description: null,
};

const sampleSkipped: SkippedRow = {
  row: { Name: 'Missing Contact' },
  reason: 'No email or mobile number found',
};

describe('CSVImporter — Human-in-the-Loop Workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completing AI extraction transitions to Review AI Results step and DOES NOT navigate to Manage Leads', async () => {
    mockExtractLeads.mockImplementation(async (_file, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 1,
        batchRecords: [sampleExtractedLead],
        batchSkipped: [sampleSkipped],
      });
      onEvent({
        type: 'complete',
        pendingImportId: 'pending_123',
        totalValid: 1,
        totalSkipped: 1,
        totalFailed: 0,
        totalImported: 0,
      });
    });

    render(<CSVImporter />);

    // 1. Open modal
    fireEvent.click(screen.getByRole('button', { name: /import leads/i }));

    // 2. Upload CSV
    fireEvent.click(screen.getByText('Simulate CSV Upload'));

    // In preview step, verify "Process with AI" is shown
    const processBtn = screen.getByRole('button', { name: /process with ai/i });
    expect(processBtn).toBeInTheDocument();

    // 3. Click "Process with AI"
    fireEvent.click(processBtn);

    // 4. Wait for Review step to display
    await waitFor(() => {
      expect(screen.getByText(/Review AI Results & Approve Import/i)).toBeInTheDocument();
    });

    // CRITICAL: Verify router.push was NOT called when Gemini finished
    expect(mockPush).not.toHaveBeenCalled();

    // 5. Verify the AI-transformed CRM records are displayed in the review table
    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('john@example.com')).toBeInTheDocument();
    expect(screen.getByText('+1 4155551234')).toBeInTheDocument();
    expect(screen.getByText('Good Lead')).toBeInTheDocument();
    expect(screen.getByText('leads_on_demand')).toBeInTheDocument();

    // Verify Pending Status & Stats are displayed
    expect(screen.getByText('Pending Approval')).toBeInTheDocument();
    expect(screen.getByText('Valid Leads')).toBeInTheDocument();
    expect(screen.getByText('Skipped Rows')).toBeInTheDocument();

    // Verify Action buttons are available
    expect(screen.getByRole('button', { name: /reject import/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve & import \(1 leads\)/i })).toBeInTheDocument();
  });

  it('navigates to Manage Leads ONLY after explicit human approval and successful persistence', async () => {
    mockExtractLeads.mockImplementation(async (_file, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 1,
        batchRecords: [sampleExtractedLead],
        batchSkipped: [],
      });
      onEvent({
        type: 'complete',
        pendingImportId: 'pending_test_approve',
        totalValid: 1,
        totalSkipped: 0,
        totalFailed: 0,
        totalImported: 0,
      });
    });

    mockApprove.mockResolvedValue({
      success: true,
      importId: 'final_crm_import_777',
      totalImported: 1,
    });

    render(<CSVImporter />);

    fireEvent.click(screen.getByRole('button', { name: /import leads/i }));
    fireEvent.click(screen.getByText('Simulate CSV Upload'));
    fireEvent.click(screen.getByRole('button', { name: /process with ai/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve & import \(1 leads\)/i })).toBeInTheDocument();
    });

    // Click Approve & Import
    fireEvent.click(screen.getByRole('button', { name: /approve & import \(1 leads\)/i }));

    // Verify approval API call was made with the pendingImportId
    await waitFor(() => {
      expect(mockApprove).toHaveBeenCalledWith('pending_test_approve');
    });

    // Verify navigation happened ONLY after approval resolved successfully
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/manage-leads?importId=final_crm_import_777');
    });
  });

  it('handles rejection by confirming no leads were added and DOES NOT navigate to Manage Leads', async () => {
    mockExtractLeads.mockImplementation(async (_file, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 1,
        batchRecords: [sampleExtractedLead],
        batchSkipped: [],
      });
      onEvent({
        type: 'complete',
        pendingImportId: 'pending_to_reject',
        totalValid: 1,
        totalSkipped: 0,
        totalFailed: 0,
        totalImported: 0,
      });
    });

    mockReject.mockResolvedValue({
      success: true,
      message: 'Import rejected. No records were added to your CRM.',
      status: 'REJECTED',
    });

    render(<CSVImporter />);

    fireEvent.click(screen.getByRole('button', { name: /import leads/i }));
    fireEvent.click(screen.getByText('Simulate CSV Upload'));
    fireEvent.click(screen.getByRole('button', { name: /process with ai/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reject import/i })).toBeInTheDocument();
    });

    // Click Reject Import
    fireEvent.click(screen.getByRole('button', { name: /reject import/i }));

    await waitFor(() => {
      expect(mockReject).toHaveBeenCalledWith('pending_to_reject');
    });

    // Verify rejection confirmation screen is shown
    await waitFor(() => {
      expect(screen.getByText('Import Rejected')).toBeInTheDocument();
      expect(screen.getByText(/No leads were written into your CRM/i)).toBeInTheDocument();
    });

    // Confirm navigation was never triggered
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('retains review screen and displays retryable error when approval persistence fails', async () => {
    mockExtractLeads.mockImplementation(async (_file, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 1,
        batchRecords: [sampleExtractedLead],
        batchSkipped: [],
      });
      onEvent({
        type: 'complete',
        pendingImportId: 'pending_fail',
        totalValid: 1,
        totalSkipped: 0,
        totalFailed: 0,
        totalImported: 0,
      });
    });

    mockApprove.mockRejectedValue(new Error('Database lock timeout'));

    render(<CSVImporter />);

    fireEvent.click(screen.getByRole('button', { name: /import leads/i }));
    fireEvent.click(screen.getByText('Simulate CSV Upload'));
    fireEvent.click(screen.getByRole('button', { name: /process with ai/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve & import \(1 leads\)/i })).toBeInTheDocument();
    });

    // Click Approve
    fireEvent.click(screen.getByRole('button', { name: /approve & import \(1 leads\)/i }));

    // Verify review screen is retained and error message is displayed
    await waitFor(() => {
      expect(screen.getByText('Approval Failed')).toBeInTheDocument();
      expect(screen.getByText('Database lock timeout')).toBeInTheDocument();
    });

    // Verify navigation was NOT called
    expect(mockPush).not.toHaveBeenCalled();

    // Verify button is still available for retry
    expect(screen.getByRole('button', { name: /approve & import \(1 leads\)/i })).toBeInTheDocument();
  });

  it('allows inspecting skipped rows and their reasons in the review screen', async () => {
    mockExtractLeads.mockImplementation(async (_file, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 1,
        batchRecords: [sampleExtractedLead],
        batchSkipped: [
          {
            row: { Name: 'Missing Guy', Notes: 'Random note' },
            reason: 'No email or mobile number found',
          },
        ],
      });
      onEvent({
        type: 'complete',
        pendingImportId: 'pending_skipped_check',
        totalValid: 1,
        totalSkipped: 1,
        totalFailed: 0,
        totalImported: 0,
      });
    });

    render(<CSVImporter />);

    fireEvent.click(screen.getByRole('button', { name: /import leads/i }));
    fireEvent.click(screen.getByText('Simulate CSV Upload'));
    fireEvent.click(screen.getByRole('button', { name: /process with ai/i }));

    await waitFor(() => {
      expect(screen.getByText('Skipped (1)')).toBeInTheDocument();
    });

    // Switch to Skipped tab
    fireEvent.click(screen.getByText('Skipped (1)'));

    // Verify skipped reason and raw data are displayed
    expect(screen.getByText('No email or mobile number found')).toBeInTheDocument();
    expect(screen.getByText('Missing Guy')).toBeInTheDocument();
  });

  it('closing the modal does not trigger approval or persistence', async () => {
    mockExtractLeads.mockImplementation(async (_file, onEvent) => {
      onEvent({
        type: 'progress',
        batchIndex: 1,
        totalBatches: 1,
        batchRecords: [sampleExtractedLead],
        batchSkipped: [],
      });
      onEvent({
        type: 'complete',
        pendingImportId: 'pending_close_test',
        totalValid: 1,
        totalSkipped: 0,
        totalFailed: 0,
        totalImported: 0,
      });
    });

    render(<CSVImporter />);

    fireEvent.click(screen.getByRole('button', { name: /import leads/i }));
    fireEvent.click(screen.getByText('Simulate CSV Upload'));
    fireEvent.click(screen.getByRole('button', { name: /process with ai/i }));

    await waitFor(() => {
      expect(screen.getByText(/Review AI Results/i)).toBeInTheDocument();
    });

    // Close the modal via X button
    fireEvent.click(screen.getByLabelText('Close modal'));

    // Verify modal is closed
    expect(screen.queryByText(/Review AI Results/i)).not.toBeInTheDocument();

    // Verify neither approve nor reject nor push were called
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
