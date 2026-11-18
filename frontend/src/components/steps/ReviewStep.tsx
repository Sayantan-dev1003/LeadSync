'use client';

import { useState, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Search,
  ChevronDown,
  AlertCircle,
  FileText,
  Clock,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { clsx } from 'clsx';
import { format } from 'date-fns';
import type { CRMRecord, SkippedRow, FailedRow, CrmStatus } from '@/types';
import { CRM_STATUS_LABELS, CRM_STATUS_COLORS } from '@/types';

interface ReviewStepProps {
  pendingImportId: string;
  filename: string;
  totalOriginalRows: number;
  records: CRMRecord[];
  skipped: SkippedRow[];
  failed: FailedRow[];
  isApproving: boolean;
  isRejecting: boolean;
  approvalError: string | null;
  rejectionConfirmed: boolean;
  isExpired?: boolean;
  onApprove: () => void;
  onReject: () => void;
  onDismissRejection: () => void;
}

function StatusPill({ status }: { status: CrmStatus | null | undefined }) {
  if (!status || !(status in CRM_STATUS_LABELS)) {
    return <span className="text-xs dark:text-white/30 text-slate-400 italic">—</span>;
  }
  return (
    <span className={clsx(CRM_STATUS_COLORS[status], 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium')}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {CRM_STATUS_LABELS[status]}
    </span>
  );
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : format(d, 'MMM d, yyyy');
  } catch {
    return dateStr;
  }
}

export function ReviewStep({
  pendingImportId,
  filename,
  totalOriginalRows,
  records,
  skipped,
  failed,
  isApproving,
  isRejecting,
  approvalError,
  rejectionConfirmed,
  isExpired = false,
  onApprove,
  onReject,
  onDismissRejection,
}: ReviewStepProps) {
  const [search, setSearch] = useState('');
  const [showSkipped, setShowSkipped] = useState(false);
  const [showFailed, setShowFailed] = useState(false);
  const [activeTab, setActiveTab] = useState<'valid' | 'skipped' | 'failed'>('valid');

  const parentRef = useRef<HTMLDivElement>(null);

  // Filter records by search
  const filteredRecords = useMemo(() => {
    if (!search.trim()) return records;
    const q = search.toLowerCase();
    return records.filter(
      (r) =>
        r.name?.toLowerCase().includes(q) ||
        r.email?.toLowerCase().includes(q) ||
        r.mobile_without_country_code?.includes(q) ||
        r.company?.toLowerCase().includes(q) ||
        r.city?.toLowerCase().includes(q) ||
        r.crm_status?.toLowerCase().includes(q)
    );
  }, [records, search]);

  const rowVirtualizer = useVirtualizer({
    count: filteredRecords.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  // Rejection confirmation screen
  if (rejectionConfirmed) {
    return (
      <div className="py-12 px-4 flex flex-col items-center text-center animate-fade-in space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500 dark:text-slate-400">
          <XCircle className="w-8 h-8 text-amber-500" />
        </div>
        <div className="max-w-md space-y-2">
          <h3 className="text-lg font-bold dark:text-white text-slate-900">
            Import Rejected
          </h3>
          <p className="text-sm dark:text-white/60 text-slate-500">
            This pending import has been rejected. No leads were written into your CRM, and staged data has been discarded.
          </p>
        </div>
        <button
          onClick={onDismissRejection}
          className="mt-4 px-6 py-2.5 rounded-lg bg-slate-200 dark:bg-white/10 hover:bg-slate-300 dark:hover:bg-white/20 font-semibold text-sm dark:text-white text-slate-800 transition-colors"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in">
      {/* File & Staging Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3.5 rounded-xl border dark:border-brand-500/20 border-brand-200 bg-brand-50/40 dark:bg-brand-500/5 gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand-500/10 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5 text-brand-500" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold dark:text-white text-slate-900 truncate max-w-[220px]" title={filename}>
                {filename}
              </span>
              <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-300/30">
                Pending Approval
              </span>
            </div>
            <p className="text-xs dark:text-white/50 text-slate-500 flex items-center gap-1.5 mt-0.5">
              <Clock className="w-3 h-3" />
              Staged temporarily &bull; Valid for 24 hours
            </p>
          </div>
        </div>

        <div className="text-xs dark:text-white/50 text-slate-500 sm:text-right shrink-0">
          Pending ID: <span className="font-mono text-[11px] dark:text-white/70 text-slate-700">{pendingImportId.slice(0, 10)}...</span>
        </div>
      </div>

      {/* Expiration Banner */}
      {isExpired && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300">
          <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">Pending Import Expired</p>
            <p className="text-xs opacity-90 mt-0.5">
              This import has exceeded its temporary retention window and cannot be committed. Please upload the CSV again to proceed.
            </p>
          </div>
        </div>
      )}

      {/* Approval Failure Banner */}
      {approvalError && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300 animate-fade-in">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-500" />
          <div className="text-sm flex-1">
            <p className="font-semibold">Approval Failed</p>
            <p className="text-xs opacity-90 mt-0.5">{approvalError}</p>
            <p className="text-xs opacity-75 mt-1">
              Your pending records are still preserved. You can review the issues below and retry.
            </p>
          </div>
        </div>
      )}

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div
          onClick={() => setActiveTab('valid')}
          className={clsx(
            'p-3.5 rounded-xl border transition-colors cursor-pointer',
            activeTab === 'valid'
              ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-500/10'
              : 'border-slate-200 dark:border-white/10 dark:bg-surface-800 bg-slate-50'
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Valid Leads</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold dark:text-white text-slate-900 mt-1">{records.length}</div>
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5 font-medium">Ready to import</p>
        </div>

        <div
          onClick={() => setActiveTab('skipped')}
          className={clsx(
            'p-3.5 rounded-xl border transition-colors cursor-pointer',
            activeTab === 'skipped'
              ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-500/10'
              : 'border-slate-200 dark:border-white/10 dark:bg-surface-800 bg-slate-50'
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Skipped Rows</span>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-2xl font-bold dark:text-white text-slate-900 mt-1">{skipped.length}</div>
          <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5 font-medium">No contact info</p>
        </div>

        <div
          onClick={() => setActiveTab('failed')}
          className={clsx(
            'p-3.5 rounded-xl border transition-colors cursor-pointer',
            activeTab === 'failed'
              ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-500/10'
              : 'border-slate-200 dark:border-white/10 dark:bg-surface-800 bg-slate-50'
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Failed Rows</span>
            <XCircle className="w-4 h-4 text-red-500" />
          </div>
          <div className="text-2xl font-bold dark:text-white text-slate-900 mt-1">{failed.length}</div>
          <p className="text-[11px] text-red-600 dark:text-red-400 mt-0.5 font-medium">Validation errors</p>
        </div>

        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-white/10 dark:bg-surface-800 bg-slate-50">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Original Rows</span>
            <FileText className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-2xl font-bold dark:text-white text-slate-900 mt-1">{totalOriginalRows}</div>
          <p className="text-[11px] text-slate-500 dark:text-white/40 mt-0.5">Total processed</p>
        </div>
      </div>

      {/* Tabs / Filter Navigation */}
      <div className="flex items-center justify-between gap-3 border-b dark:border-white/10 border-slate-200 pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('valid')}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
              activeTab === 'valid'
                ? 'bg-brand-500 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5'
            )}
          >
            AI-Extracted Leads ({records.length})
          </button>
          <button
            onClick={() => setActiveTab('skipped')}
            className={clsx(
              'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
              activeTab === 'skipped'
                ? 'bg-amber-500 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5'
            )}
          >
            Skipped ({skipped.length})
          </button>
          {failed.length > 0 && (
            <button
              onClick={() => setActiveTab('failed')}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors',
                activeTab === 'failed'
                  ? 'bg-red-500 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5'
              )}
            >
              Failed ({failed.length})
            </button>
          )}
        </div>

        {activeTab === 'valid' && (
          <div className="relative w-48 sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search extracted leads..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1 text-xs rounded-lg border dark:border-white/10 border-slate-300 dark:bg-surface-900 bg-white dark:text-white text-slate-900 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        )}
      </div>

      {/* Main Tab Content */}
      {activeTab === 'valid' && (
        <div className="space-y-3">
          {filteredRecords.length === 0 ? (
            <div className="py-12 text-center text-sm dark:text-white/40 text-slate-500">
              {search ? 'No extracted records match your search filter.' : 'No valid leads extracted from this CSV.'}
            </div>
          ) : (
            <div className="rounded-xl border dark:border-white/10 border-slate-200 overflow-hidden shadow-sm">
              {/* Sticky Table Header */}
              <div className="overflow-x-auto">
                <table className="data-table" style={{ minWidth: 950, tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: 40 }} />
                    <col style={{ width: 140 }} />
                    <col style={{ width: 160 }} />
                    <col style={{ width: 130 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 100 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="text-center">#</th>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Contact Number</th>
                      <th>Date</th>
                      <th>Company</th>
                      <th>Status</th>
                      <th>Data Source</th>
                      <th>Lead Owner</th>
                    </tr>
                  </thead>
                </table>
              </div>

              {/* Virtualized Body */}
              <div
                ref={parentRef}
                className="overflow-auto bg-white dark:bg-surface-900"
                style={{ maxHeight: 360 }}
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const r = filteredRecords[virtualRow.index];
                    return (
                      <div
                        key={virtualRow.index}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <div className="overflow-x-auto">
                          <table className="data-table" style={{ minWidth: 950, tableLayout: 'fixed' }}>
                            <colgroup>
                              <col style={{ width: 40 }} />
                              <col style={{ width: 140 }} />
                              <col style={{ width: 160 }} />
                              <col style={{ width: 130 }} />
                              <col style={{ width: 110 }} />
                              <col style={{ width: 120 }} />
                              <col style={{ width: 110 }} />
                              <col style={{ width: 110 }} />
                              <col style={{ width: 100 }} />
                            </colgroup>
                            <tbody>
                              <tr className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
                                <td className="text-center text-xs dark:text-white/30 text-slate-400">
                                  {virtualRow.index + 1}
                                </td>
                                <td className="font-medium dark:text-white text-slate-900">
                                  <div className="truncate" title={r.name || ''}>
                                    {r.name || <span className="italic dark:text-white/30 text-slate-400 text-xs">—</span>}
                                  </div>
                                </td>
                                <td className="dark:text-white/70 text-slate-600">
                                  <div className="truncate text-xs" title={r.email || ''}>
                                    {r.email || <span className="italic dark:text-white/30 text-slate-400">—</span>}
                                  </div>
                                </td>
                                <td className="font-mono text-xs dark:text-white/70 text-slate-600">
                                  <div className="truncate">
                                    {r.country_code && r.mobile_without_country_code
                                      ? `${r.country_code} ${r.mobile_without_country_code}`
                                      : r.mobile_without_country_code || <span className="italic dark:text-white/30 text-slate-400">—</span>}
                                  </div>
                                </td>
                                <td className="text-xs dark:text-white/60 text-slate-500">
                                  {formatDate(r.created_at)}
                                </td>
                                <td className="dark:text-white/70 text-slate-600 text-xs">
                                  <div className="truncate" title={r.company || ''}>
                                    {r.company || '—'}
                                  </div>
                                </td>
                                <td>
                                  <StatusPill status={r.crm_status} />
                                </td>
                                <td className="text-xs dark:text-white/50 text-slate-500">
                                  <div className="truncate" title={r.data_source || ''}>
                                    {r.data_source || '—'}
                                  </div>
                                </td>
                                <td className="text-xs dark:text-white/60 text-slate-500">
                                  <div className="truncate" title={r.lead_owner || ''}>
                                    {r.lead_owner || '—'}
                                  </div>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Skipped Rows Tab */}
      {activeTab === 'skipped' && (
        <div className="space-y-3">
          {skipped.length === 0 ? (
            <div className="py-8 text-center text-sm dark:text-white/40 text-slate-500">
              No skipped rows found. All rows contained valid contact info.
            </div>
          ) : (
            <div className="rounded-xl border dark:border-amber-500/20 border-amber-200 overflow-hidden divide-y dark:divide-white/5 divide-slate-100 max-h-80 overflow-y-auto">
              {skipped.map((s, idx) => (
                <div key={idx} className="p-3 dark:bg-amber-500/5 bg-amber-50/50 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                      Row #{idx + 1}
                    </span>
                    <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                      {s.reason}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                    {Object.entries(s.row).map(([k, v]) => (
                      <span key={k} className="px-2 py-0.5 rounded bg-white dark:bg-surface-800 border dark:border-white/5 border-slate-200 text-slate-600 dark:text-slate-300">
                        <span className="font-semibold text-slate-400 dark:text-slate-500">{k}:</span> {String(v || '—')}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Failed Rows Tab */}
      {activeTab === 'failed' && (
        <div className="space-y-3">
          {failed.length === 0 ? (
            <div className="py-8 text-center text-sm dark:text-white/40 text-slate-500">
              No failed rows.
            </div>
          ) : (
            <div className="rounded-xl border dark:border-red-500/20 border-red-200 overflow-hidden divide-y dark:divide-white/5 divide-slate-100 max-h-80 overflow-y-auto">
              {failed.map((f, idx) => (
                <div key={idx} className="p-3 dark:bg-red-500/5 bg-red-50/50 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">
                      Row #{idx + 1}
                    </span>
                    <span className="text-xs font-medium text-red-700 dark:text-red-300">
                      {f.reason}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                    {Object.entries(f.row).map(([k, v]) => (
                      <span key={k} className="px-2 py-0.5 rounded bg-white dark:bg-surface-800 border dark:border-white/5 border-slate-200 text-slate-600 dark:text-slate-300">
                        <span className="font-semibold text-slate-400 dark:text-slate-500">{k}:</span> {String(v || '—')}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}