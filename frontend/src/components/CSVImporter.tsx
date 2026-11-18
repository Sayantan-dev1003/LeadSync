'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { UploadStep } from '@/components/steps/UploadStep';
import { PreviewStep } from '@/components/steps/PreviewStep';
import { ReviewStep } from '@/components/steps/ReviewStep';
import type { ParsedCSV, Step, CRMRecord, SkippedRow, FailedRow } from '@/types';
import { X, Loader2, Sparkles, Check, Ban } from 'lucide-react';
import { extractLeads, approvePendingImport, rejectPendingImport } from '@/lib/api';
import { clsx } from 'clsx';

export function CSVImporter() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>('upload');
  const [parsedCSV, setParsedCSV] = useState<ParsedCSV | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Extraction streaming state
  const [isExtracting, setIsExtracting] = useState(false);
  const [progressPct, setProgressPct] = useState(0);

  // Staged AI results
  const [pendingImportId, setPendingImportId] = useState<string | null>(null);
  const [extractedRecords, setExtractedRecords] = useState<CRMRecord[]>([]);
  const [extractedSkipped, setExtractedSkipped] = useState<SkippedRow[]>([]);
  const [extractedFailed, setExtractedFailed] = useState<FailedRow[]>([]);

  // Approval / Rejection states
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [rejectionConfirmed, setRejectionConfirmed] = useState(false);

  const resetAllState = useCallback(() => {
    setStep('upload');
    setParsedCSV(null);
    setSelectedFile(null);
    setIsExtracting(false);
    setProgressPct(0);
    setPendingImportId(null);
    setExtractedRecords([]);
    setExtractedSkipped([]);
    setExtractedFailed([]);
    setIsApproving(false);
    setIsRejecting(false);
    setApprovalError(null);
    setRejectionConfirmed(false);
  }, []);

  const handleParsed = useCallback((data: ParsedCSV, file: File) => {
    setParsedCSV(data);
    setSelectedFile(file);
    setStep('preview');
  }, []);

  // Phase A: Trigger AI extraction, stream SSE, then navigate to Review AI Results
  const handleProcessWithAI = async () => {
    if (!selectedFile) return;

    setIsExtracting(true);
    setProgressPct(0);
    setApprovalError(null);

    const recordsAccumulator: CRMRecord[] = [];
    const skippedAccumulator: SkippedRow[] = [];
    const failedAccumulator: FailedRow[] = [];

    try {
      await extractLeads(selectedFile, (event) => {
        if (event.type === 'progress') {
          const pct = Math.round((event.batchIndex / event.totalBatches) * 100);
          setProgressPct(pct);

          recordsAccumulator.push(...event.batchRecords);
          skippedAccumulator.push(...event.batchSkipped);
          if (event.batchFailed) {
            failedAccumulator.push(...event.batchFailed);
          }
        } else if (event.type === 'complete') {
          // Extraction finished! Do NOT navigate to Manage Leads.
          // Save pending ID and staged records, then transition to human review step.
          setProgressPct(100);

          if (event.pendingImportId) {
            setPendingImportId(event.pendingImportId);
          }
          setExtractedRecords([...recordsAccumulator]);
          setExtractedSkipped([...skippedAccumulator]);
          setExtractedFailed([...failedAccumulator]);

          // Move to review step
          setIsExtracting(false);
          setStep('review');
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to extract data. Please try again.';
      console.error('Extraction failed:', error);
      alert(`AI Extraction failed: ${message}`);
      setIsExtracting(false);
      setProgressPct(0);
    }
  };

  // Phase B: Explicit human approval
  const handleApprove = async () => {
    if (!pendingImportId || isApproving || isRejecting) return;

    setIsApproving(true);
    setApprovalError(null);

    try {
      const result = await approvePendingImport(pendingImportId);

      if (result.success && result.importId) {
        // Human approval confirmed and committed to CRM!
        setIsOpen(false);
        router.push(`/manage-leads?importId=${result.importId}`);
        setTimeout(resetAllState, 500);
      } else {
        throw new Error('Database persistence did not return a valid import ID');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Database import failed. Please retry.';
      console.error('Approval failed:', err);
      setApprovalError(message);
    } finally {
      setIsApproving(false);
    }
  };

  // Step 3: Explicit human rejection
  const handleReject = async () => {
    if (!pendingImportId || isApproving || isRejecting) return;

    setIsRejecting(true);
    setApprovalError(null);

    try {
      const result = await rejectPendingImport(pendingImportId);
      if (result.success) {
        setRejectionConfirmed(true);
      } else {
        throw new Error(result.message || 'Failed to reject import');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rejection failed. Please try again.';
      console.error('Rejection failed:', err);
      setApprovalError(message);
    } finally {
      setIsRejecting(false);
    }
  };

  const handleClose = () => {
    // Closing modal does NOT approve or commit any pending import
    setIsOpen(false);
    resetAllState();
  };

  return (
    <>
      <button
        onClick={() => {
          resetAllState();
          setIsOpen(true);
        }}
        className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors"
      >
        Import Leads
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in p-4">
          <div
            className={clsx(
              'bg-white dark:bg-surface-900 rounded-2xl shadow-xl w-full overflow-hidden border dark:border-white/10 border-slate-200 flex flex-col max-h-[90vh] transition-all duration-300',
              step === 'review' ? 'max-w-5xl' : 'max-w-2xl'
            )}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between p-4 md:p-6 border-b dark:border-white/10 border-slate-200 shrink-0">
              <div>
                <h2 className="text-xl font-bold dark:text-white text-slate-900">
                  {step === 'review'
                    ? 'Review AI Results & Approve Import'
                    : 'Import Leads via CSV'}
                </h2>
                <p className="text-sm dark:text-white/50 text-slate-500 mt-1">
                  {step === 'review'
                    ? 'Inspect AI-transformed CRM fields before committing leads to the database.'
                    : 'Upload a CSV file to bulk import leads into your system.'}
                </p>
              </div>
              <button
                onClick={handleClose}
                className="p-2 hover:bg-slate-100 dark:hover:bg-white/5 rounded-full transition-colors"
                aria-label="Close modal"
              >
                <X className="w-5 h-5 dark:text-slate-400 text-slate-500" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 md:p-6 overflow-y-auto">
              {step === 'upload' && <UploadStep onParsed={handleParsed} />}

              {step === 'preview' && parsedCSV && (
                <div className="space-y-4">
                  <PreviewStep
                    data={parsedCSV}
                    onClear={() => {
                      setStep('upload');
                      setParsedCSV(null);
                      setSelectedFile(null);
                    }}
                  />
                </div>
              )}

              {step === 'review' && pendingImportId && (
                <ReviewStep
                  pendingImportId={pendingImportId}
                  filename={parsedCSV?.filename || 'import.csv'}
                  totalOriginalRows={parsedCSV?.totalRows || extractedRecords.length + extractedSkipped.length + extractedFailed.length}
                  records={extractedRecords}
                  skipped={extractedSkipped}
                  failed={extractedFailed}
                  isApproving={isApproving}
                  isRejecting={isRejecting}
                  approvalError={approvalError}
                  rejectionConfirmed={rejectionConfirmed}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onDismissRejection={handleClose}
                />
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex flex-col-reverse sm:flex-row items-stretch gap-3 sm:gap-4 p-4 md:p-6 border-t dark:border-white/10 border-slate-200 shrink-0">
              {step === 'review' ? (
                // Review Step Footer: Explicit Rejection & Approval Actions
                rejectionConfirmed ? (
                  <button
                    onClick={handleClose}
                    className="w-full py-2.5 rounded-lg border dark:border-white/10 border-slate-200 font-semibold dark:text-white text-slate-900 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
                  >
                    Done
                  </button>
                ) : (
                  <>
                    <button
                      id="reject-import-btn"
                      onClick={handleReject}
                      disabled={isApproving || isRejecting}
                      className="flex-1 py-2.5 px-4 rounded-lg border border-red-200 dark:border-red-500/30 font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {isRejecting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Rejecting...</span>
                        </>
                      ) : (
                        <>
                          <Ban className="w-4 h-4" />
                          <span>Reject Import</span>
                        </>
                      )}
                    </button>

                    <button
                      id="approve-import-btn"
                      onClick={handleApprove}
                      disabled={isApproving || isRejecting || extractedRecords.length === 0}
                      className={clsx(
                        'flex-1 py-2.5 px-4 rounded-lg font-semibold text-white transition-colors shadow-sm flex items-center justify-center gap-2',
                        isApproving
                          ? 'bg-emerald-600 cursor-wait'
                          : extractedRecords.length === 0
                          ? 'bg-slate-400 cursor-not-allowed opacity-50'
                          : 'bg-emerald-600 hover:bg-emerald-700'
                      )}
                    >
                      {isApproving ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Importing to CRM...</span>
                        </>
                      ) : (
                        <>
                          <Check className="w-4 h-4" />
                          <span>Approve & Import ({extractedRecords.length} Leads)</span>
                        </>
                      )}
                    </button>
                  </>
                )
              ) : (
                // Upload & Preview Step Footer
                <>
                  <button
                    onClick={handleClose}
                    disabled={isExtracting}
                    className="flex-1 py-2.5 rounded-lg border dark:border-white/10 border-slate-200 font-semibold dark:text-white text-slate-900 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    id="process-with-ai-btn"
                    onClick={handleProcessWithAI}
                    disabled={step === 'upload' || !parsedCSV || isExtracting}
                    className={`relative flex-1 overflow-hidden py-2.5 px-4 rounded-lg bg-orange-500 text-white font-semibold transition-colors shadow-sm flex items-center justify-center gap-2 ${
                      (step === 'upload' || !parsedCSV) && !isExtracting
                        ? 'opacity-50 cursor-not-allowed'
                        : isExtracting
                        ? 'cursor-wait'
                        : 'hover:bg-orange-600'
                    }`}
                  >
                    {/* Progress bar background during extraction */}
                    {isExtracting && (
                      <div
                        className="absolute left-0 top-0 bottom-0 bg-orange-700 transition-all duration-300 ease-out"
                        style={{ width: `${progressPct}%` }}
                      />
                    )}

                    {/* Button Content */}
                    <span className="relative z-10 flex items-center justify-center w-full gap-2">
                      {isExtracting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Processing with AI ({progressPct}%)...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4" />
                          <span>Process with AI</span>
                        </>
                      )}
                    </span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}