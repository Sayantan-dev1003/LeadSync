'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Database, ArrowRight, ShieldAlert, Inbox } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

const BACKEND_URL =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_BACKEND_URL || '')
    : (process.env.BACKEND_PROXY_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000');

interface ImportJob {
  id: string;
  filename: string;
  totalRows: number;
  totalImported: number;
  totalSkipped: number;
  createdAt: string;
}

export function RecentImports() {
  const router = useRouter();
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [imports, setImports] = useState<ImportJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Phase 6: In public unauthenticated mode, do NOT query owner-only endpoints
    if (!isAuthenticated) {
      setImports([]);
      setIsLoading(false);
      return;
    }

    const fetchImports = async () => {
      try {
        setIsLoading(true);
        const res = await fetch(`${BACKEND_URL}/api/imports`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          setImports(data.imports || []);
        } else {
          setImports([]);
        }
      } catch (error) {
        console.error('Failed to fetch imports:', error);
        setImports([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchImports();
  }, [isAuthenticated]);

  if (isAuthLoading || isLoading) {
    return (
      <div className="mt-8" data-testid="recent-imports-loading">
        <h3 className="text-lg font-semibold dark:text-white text-slate-900 mb-4">Recent Imports</h3>
        <div className="text-slate-500 text-sm flex items-center gap-2">
          <div className="w-4 h-4 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
          Loading imports...
        </div>
      </div>
    );
  }

  // Public Read-Only Mode State (Unauthenticated)
  if (!isAuthenticated) {
    return (
      <div className="mt-8" data-testid="public-recent-imports">
        <h3 className="text-lg font-semibold dark:text-white text-slate-900 mb-4">Recent Imports</h3>
        <div className="border border-slate-200 dark:border-white/10 rounded-xl p-8 dark:bg-surface-800/40 bg-white text-center">
          <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-slate-500 flex items-center justify-center mx-auto mb-3">
            <Inbox className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-semibold dark:text-white text-slate-800">
            Public Read-Only Mode
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
            Zero recent imports. Real CRM imports and historical records are private to the verified owner. Sign in with Google above to view private data.
          </p>
        </div>
      </div>
    );
  }

  // Authenticated Owner with 0 records
  if (imports.length === 0) {
    return (
      <div className="mt-8">
        <h3 className="text-lg font-semibold dark:text-white text-slate-900 mb-4">Recent Imports</h3>
        <div className="border border-slate-200 dark:border-white/10 rounded-xl p-8 dark:bg-surface-800/40 bg-white text-center">
          <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-white/5 text-slate-400 dark:text-slate-500 flex items-center justify-center mx-auto mb-3">
            <FileText className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-semibold dark:text-white text-slate-800">
            No imports yet
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Upload your first CSV file above to start importing leads.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8" data-testid="owner-recent-imports">
      <h3 className="text-lg font-semibold dark:text-white text-slate-900 mb-4">Recent Imports</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {imports.map((job) => (
          <div
            key={job.id}
            onClick={() => router.push(`/manage-leads?importId=${job.id}`)}
            className="cursor-pointer border dark:border-white/10 border-slate-200 rounded-xl p-5 dark:bg-surface-800 bg-white hover:border-brand-500/50 dark:hover:border-brand-500/50 transition-all hover:shadow-md group flex flex-col justify-between"
          >
            <div>
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {new Date(job.createdAt).toLocaleDateString()}
                </div>
              </div>
              <h4 className="font-semibold text-sm dark:text-white text-slate-900 truncate mb-1" title={job.filename}>
                {job.filename}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                {job.totalRows} rows processed
              </p>
            </div>
            
            <div className="flex items-center justify-between border-t dark:border-white/10 border-slate-100 pt-3">
              <div className="flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-brand-500" />
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  {job.totalImported} leads imported
                </span>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-brand-500 group-hover:translate-x-1 transition-all" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
