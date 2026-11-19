'use client';

export const dynamic = 'force-dynamic';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Search, RefreshCw, Inbox, Lock } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { AIUsageSummaryCard } from '@/components/AIUsageSummaryCard';
import type { ImportAiUsageSummary } from '@/types';

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_BACKEND_URL || '')
    : (process.env.BACKEND_PROXY_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000');

interface Lead {
  id: string;
  name: string | null;
  email: string | null;
  mobileWithoutCountryCode: string | null;
  countryCode: string | null;
  createdAt: string | null;
  importedAt: string;
  company: string | null;
  crmStatus: string | null;
}

interface ImportJob {
  id: string;
  totalImported: number;
  totalSkipped: number;
  aiUsage?: ImportAiUsageSummary | null;
}

interface SkippedRow {
  id: string;
  rawRow: string;
  reason: string;
}

function ManageLeadsContent() {
  const searchParams = useSearchParams();
  const importId = searchParams.get('importId');
  const { isAuthenticated, isLoading: isAuthLoading, login } = useAuth();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [skippedRows, setSkippedRows] = useState<SkippedRow[]>([]);
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'parsed' | 'skipped'>('parsed');

  const fetchLeads = async (currentSearch = searchQuery) => {
    // Phase 6: Never query owner-only endpoints in public unauthenticated mode
    if (!isAuthenticated) {
      setLeads([]);
      setSkippedRows([]);
      setImportJob(null);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const searchParam = currentSearch ? `?search=${encodeURIComponent(currentSearch)}` : '';
      const url = importId 
        ? `${BACKEND_URL}/api/imports/${importId}/leads${searchParam}`
        : `${BACKEND_URL}/api/leads${searchParam}`;

      const res = await fetch(url, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        setLeads(data.leads || []);
      } else {
        setLeads([]);
      }
      
      if (importId) {
        // Fetch stats
        const statsRes = await fetch(`${BACKEND_URL}/api/imports/${importId}`, {
          credentials: 'include',
        });
        if (statsRes.ok) {
          const statsData = await statsRes.json();
          setImportJob(statsData.importJob);
        }
        
        // Fetch skipped if tab is skipped
        if (activeTab === 'skipped') {
          const skipRes = await fetch(`${BACKEND_URL}/api/imports/${importId}/skipped`, {
            credentials: 'include',
          });
          if (skipRes.ok) {
            const skipData = await skipRes.json();
            setSkippedRows(skipData.skippedRows || []);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching leads:', error);
      setLeads([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
  }, [importId, activeTab, isAuthenticated]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isAuthenticated) {
      fetchLeads(searchQuery);
    }
  };

  const getStatusBadge = (status: string | null) => {
    if (!status) return <span className="px-2 py-1 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 rounded-md text-xs font-medium">—</span>;
    switch (status) {
      case 'SALE_DONE':
      case 'Sale Done':
        return <span className="px-2 py-1 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded-md text-xs font-medium">Sale Done</span>;
      case 'GOOD_LEAD_FOLLOW_UP':
      case 'Good Lead':
        return <span className="px-2 py-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 rounded-md text-xs font-medium">Good Lead</span>;
      case 'DID_NOT_CONNECT':
      case 'Not Dialed':
        return <span className="px-2 py-1 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 rounded-md text-xs font-medium">Not Dialed</span>;
      case 'BAD_LEAD':
      case 'Bad Lead':
        return <span className="px-2 py-1 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 rounded-md text-xs font-medium">Bad Lead</span>;
      default:
        const formatted = status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        return <span className="px-2 py-1 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 rounded-md text-xs font-medium">{formatted}</span>;
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  };

  return (
    <main className="min-h-screen p-4 md:p-8 transition-colors duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-8 gap-4">
        <div>
          <h2 className="text-2xl font-bold dark:text-white text-slate-900">Manage Your Leads</h2>
          <p className="text-sm dark:text-white/50 text-slate-500 mt-1">
            Monitor lead status, assign tasks, and close deals faster.
          </p>
        </div>
      </div>

      {isAuthenticated && importId && importJob && (
        <div className="space-y-4 mb-6">
          {importJob.aiUsage && (
            <AIUsageSummaryCard
              usage={importJob.aiUsage}
              title="Import AI Token Usage & Cost Observability"
            />
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div 
            onClick={() => setActiveTab('parsed')}
            className={`p-4 rounded-xl border cursor-pointer transition-colors ${activeTab === 'parsed' ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-slate-200 dark:border-white/10 hover:border-brand-300 dark:bg-surface-800 bg-white'}`}
          >
            <div className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium">Successfully parsed records</div>
            <div className="text-xl sm:text-2xl font-bold dark:text-white text-slate-900 mt-1">{importJob.totalImported}</div>
          </div>
          
          <div 
            onClick={() => setActiveTab('skipped')}
            className={`p-4 rounded-xl border cursor-pointer transition-colors ${activeTab === 'skipped' ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-slate-200 dark:border-white/10 hover:border-brand-300 dark:bg-surface-800 bg-white'}`}
          >
            <div className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium">Skipped records</div>
            <div className="text-xl sm:text-2xl font-bold dark:text-white text-slate-900 mt-1">{importJob.totalSkipped}</div>
          </div>
          
          <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 dark:bg-surface-800 bg-white">
            <div className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium">Total imported</div>
            <div className="text-xl sm:text-2xl font-bold dark:text-white text-slate-900 mt-1">{importJob.totalImported}</div>
          </div>
          
          <div className="p-4 rounded-xl border border-slate-200 dark:border-white/10 dark:bg-surface-800 bg-white">
            <div className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium">Total skipped</div>
            <div className="text-xl sm:text-2xl font-bold dark:text-white text-slate-900 mt-1">{importJob.totalSkipped}</div>
          </div>
        </div>
      </div>
      )}

      <div className="bg-white dark:bg-surface-800 rounded-xl border dark:border-white/10 border-slate-200 overflow-hidden shadow-sm">
        {/* Table Toolbar */}
        <div className="p-4 border-b dark:border-white/10 border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <h3 className="font-semibold text-lg dark:text-white text-slate-900">Your Leads</h3>
          </div>
          <div className="flex flex-row items-center gap-3 w-full md:w-auto">
            <form onSubmit={handleSearchSubmit} className="relative flex-1 sm:flex-none w-full sm:w-auto">
              <input 
                type="text" 
                placeholder={isAuthenticated ? "Search email or phone..." : "Sign in to search leads..."} 
                value={searchQuery}
                disabled={!isAuthenticated}
                onChange={handleSearch}
                className="pl-4 pr-10 py-2 w-full sm:w-64 text-sm rounded-lg border dark:border-white/10 border-slate-300 dark:bg-surface-900 bg-white dark:text-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60 disabled:cursor-not-allowed"
              />
              <button 
                type="submit" 
                disabled={!isAuthenticated}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 bg-brand-500 rounded text-white hover:bg-brand-600 transition-colors disabled:opacity-50"
              >
                <Search className="w-4 h-4" />
              </button>
            </form>
            <button 
              onClick={() => fetchLeads()} 
              disabled={!isAuthenticated}
              className="p-2 shrink-0 border dark:border-white/10 border-slate-300 rounded-lg hover:bg-slate-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 dark:text-slate-400 text-slate-500 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          {activeTab === 'parsed' ? (
          <table className="w-full text-left text-sm" data-testid="leads-table">
            <thead>
              <tr className="border-b dark:border-white/10 border-slate-200 bg-slate-50 dark:bg-surface-700/50">
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Lead Name</th>
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Email</th>
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Contact</th>
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Date Created</th>
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Company</th>
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Status</th>
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Quality</th>
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-white/5 divide-slate-100">
              {isAuthLoading || isLoading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-slate-500 dark:text-slate-400">
                    Loading leads...
                  </td>
                </tr>
              ) : !isAuthenticated ? (
                /* Phase 6: Public Empty Read-Only Mode */
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center" data-testid="public-empty-leads">
                    <div className="max-w-md mx-auto">
                      <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-white/5 text-slate-400 flex items-center justify-center mx-auto mb-3">
                        <Lock className="w-6 h-6" />
                      </div>
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                        Public Read-Only Mode
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        Zero leads displayed. All CRM data is private to the authenticated owner. Sign in with Google to view and manage your leads.
                      </p>
                      <button
                        onClick={login}
                        className="mt-4 inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-white dark:bg-surface-700 border border-slate-300 dark:border-white/10 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-surface-600 transition-colors shadow-sm"
                      >
                        Sign in with Google as Owner
                      </button>
                    </div>
                  </td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-8 text-center text-slate-500 dark:text-slate-400" data-testid="owner-empty-leads">
                    No leads found. Import some leads via CSV to get started!
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <tr key={lead.id} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4 font-medium dark:text-white text-slate-900 whitespace-nowrap">{lead.name || '—'}</td>
                    <td className="px-6 py-4 dark:text-white/70 text-slate-600 whitespace-nowrap">{lead.email || '—'}</td>
                    <td className="px-6 py-4 dark:text-white/70 text-slate-600 whitespace-nowrap">
                      {lead.mobileWithoutCountryCode ? `${lead.countryCode ? '+' + lead.countryCode : ''}${lead.mobileWithoutCountryCode}` : '—'}
                    </td>
                    <td className="px-6 py-4 dark:text-white/70 text-slate-600 whitespace-nowrap">{formatDate(lead.createdAt || lead.importedAt)}</td>
                    <td className="px-6 py-4 dark:text-white/70 text-slate-600 whitespace-nowrap">{lead.company || '—'}</td>
                    <td className="px-6 py-4 whitespace-nowrap">{getStatusBadge(lead.crmStatus)}</td>
                    <td className="px-6 py-4 dark:text-white/70 text-slate-600 whitespace-nowrap">
                      <span className="inline-flex w-6 h-6 items-center justify-center rounded bg-slate-100 dark:bg-surface-700 text-xs font-medium">
                        —
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <span className="text-xs text-slate-400 dark:text-slate-500 font-medium">View</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b dark:border-white/10 border-slate-200 bg-slate-50 dark:bg-surface-700/50">
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Row Data</th>
                <th className="px-6 py-4 font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Reason for Skipping</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-white/5 divide-slate-100">
              {skippedRows.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-6 py-8 text-center text-slate-500 dark:text-slate-400">
                    No skipped rows recorded for this import.
                  </td>
                </tr>
              ) : (
                skippedRows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-6 py-4 font-mono text-xs dark:text-white/70 text-slate-600 max-w-md truncate">
                      {row.rawRow}
                    </td>
                    <td className="px-6 py-4 text-xs font-medium text-rose-600 dark:text-rose-400">
                      {row.reason}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          )}
        </div>
      </div>
    </main>
  );
}

export default function ManageLeadsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-slate-500">Loading leads dashboard...</div>}>
      <ManageLeadsContent />
    </Suspense>
  );
}
