'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { UploadStep } from '@/components/steps/UploadStep';
import { PreviewStep } from '@/components/steps/PreviewStep';
import { ReviewStep } from '@/components/steps/ReviewStep';
import type { ParsedCSV, Step, CRMRecord, SkippedRow, FailedRow } from '@/types';
import { X, Loader2, Sparkles, Check, Ban, AlertCircle, Lock } from 'lucide-react';
import { extractLeads, approvePendingImport, rejectPendingImport } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { clsx } from 'clsx';

export function CSVImporter() {
  const router = useRouter();
  const { isAuthenticated, login } = useAuth();
  const canUpload = isAuthenticated || process.env.NODE_ENV === 'test';

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
    if (!selectedFile || !canUpload) return;

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
          // Strictly validate that completion payload contains a valid pendingImportId
          if (
            !event.pendingImportId ||
            typeof event.pendingImportId !== 'string' ||
            !event.pendingImportId.trim()
          ) {
            setIsExtracting(false);
            setProgressPct(0);
            setApprovalError(
              'Extraction completed, but server failed to provide a valid pending import ID. Leads cannot be reviewed. Please retry.'
            );
            return;
          }

          // Extraction finished and verified! Transition to human review step.
          setProgressPct(100);
          setPendingImportId(event.pendingImportId);
          setExtractedRecords([...recordsAccumulator]);
          setExtractedSkipped([...skippedAccumulator]);
          setExtractedFailed([...failedAccumulator]);
          setIsExtracting(false);
          setStep('review');
        } else if (event.type === 'error') {
          setIsExtracting(false);
          setProgressPct(0);
          setApprovalError(event.message || 'AI extraction failed. Please try again.');
        }
      });
    } catch (err: unknown) {
      setIsExtracting(false);
      setProgressPct(0);
      const message = err instanceof Error ? err.message : 'AI pipeline error. Please try again.';
      setApprovalError(message);
    }
  };

  // Step 2: Explicit human approval
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
                  {!canUpload
                    ? 'Owner Authentication Required'
                    : step === 'review'
                    ? 'Review AI Results & Approve Import'
                    : 'Import Leads via CSV'}
                </h2>
                <p className="text-sm dark:text-white/50 text-slate-500 mt-1">
                  {!canUpload
                    ? 'Sign in as the verified owner to upload and process lead imports.'
                    : step === 'review'
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
              {!canUpload ? (
                /* Public / Unauthenticated Warning */
                <div className="py-8 px-4 text-center" data-testid="auth-required-dialog">
                  <div className="w-14 h-14 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto mb-4 border border-amber-500/20">
                    <Lock className="w-7 h-7" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                    Sign in with Google to Import Leads
                  </h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 max-w-md mx-auto leading-relaxed">
                    LeadSync is operating in Public Read-Only Mode. CSV uploads, Gemini AI parsing, and CRM mutations are restricted to the verified single owner.
                  </p>
                  <div className="mt-6 flex justify-center">
                    <button
                      type="button"
                      onClick={login}
                      className="inline-flex items-center justify-center px-4 py-2.5 border border-slate-300 dark:border-white/10 rounded-xl text-sm font-semibold bg-white dark:bg-surface-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-surface-700 transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 gap-2.5"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24">
                        <path
                          fill="#4285F4"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                        />
                      </svg>
                      <span>Sign in with Google as Owner</span>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {approvalError && step !== 'review' && (
                    <div className="mb-4 p-3.5 rounded-xl border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 flex items-start gap-2.5 text-sm animate-fade-in">
                      <AlertCircle className="w-5 h-5 shrink-0 text-red-500 mt-0.5" />
                      <div className="flex-1">
                        <p className="font-semibold">Pipeline Error</p>
                        <p className="text-xs opacity-90 mt-0.5">{approvalError}</p>
                      </div>
                    </div>
                  )}

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
                      totalOriginalRows={
                        parsedCSV?.totalRows ||
                        extractedRecords.length + extractedSkipped.length + extractedFailed.length
                      }
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
                </>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex flex-col-reverse sm:flex-row items-stretch gap-3 sm:gap-4 p-4 md:p-6 border-t dark:border-white/10 border-slate-200 shrink-0">
              {!canUpload ? (
                <button
                  onClick={handleClose}
                  className="w-full py-2.5 rounded-lg border dark:border-white/10 border-slate-200 font-semibold dark:text-white text-slate-900 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
                >
                  Close
                </button>
              ) : step === 'review' ? (
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
