'use client';

import React from 'react';
import {
  Sparkles,
  Cpu,
  Coins,
  Clock,
  Wrench,
  AlertTriangle,
  Info,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { ImportAiUsageSummary } from '@/types';

interface AIUsageSummaryCardProps {
  usage?: ImportAiUsageSummary | null;
  className?: string;
  title?: string;
}

export function AIUsageSummaryCard({
  usage,
  className,
  title = 'AI Usage Summary',
}: AIUsageSummaryCardProps) {
  if (!usage) {
    return null;
  }

  const {
    modelId,
    inputTokens,
    outputTokens,
    totalTokens,
    thoughtsTokens,
    cachedContentTokens,
    toolUsePromptTokens,
    estimatedCost,
    totalLatencyMs,
    avgLatencyMs,
    geminiRequestCount,
    missingMetadataRequestCount,
    functionCalls,
  } = usage;

  const formatMs = (ms: number) => {
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(2)}s`;
    }
    return `${ms.toLocaleString()}ms`;
  };

  const costDisplay = (() => {
    if (!estimatedCost?.pricingConfigured || estimatedCost.totalCostUsd === null) {
      return {
        text: 'Cost Unavailable',
        subtitle: 'Pricing not configured for model',
        isAvailable: false,
      };
    }

    const val = estimatedCost.totalCostUsd;
    let formatted = `$${val.toFixed(4)} USD`;
    if (val === 0) {
      formatted = '$0.00 USD';
    } else if (val < 0.0001) {
      formatted = '< $0.0001 USD';
    }

    return {
      text: formatted,
      subtitle: estimatedCost.pricingSource || 'Official Google Gemini pay-as-you-go rates',
      isAvailable: true,
    };
  })();

  return (
    <div
      data-testid="ai-usage-summary-card"
      className={clsx(
        'rounded-xl border dark:border-brand-500/20 border-brand-200/80 bg-gradient-to-br from-brand-50/30 to-slate-50/50 dark:from-brand-500/5 dark:to-surface-800/80 p-4 sm:p-5 shadow-sm transition-all',
        className
      )}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pb-3.5 border-b dark:border-white/10 border-slate-200/80">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-orange-500/10 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-sm font-bold dark:text-white text-slate-900 flex items-center gap-2">
              <span>{title}</span>
              <span className="font-mono text-[11px] font-medium px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border border-orange-200 dark:border-orange-500/20">
                {modelId || 'Gemini'}
              </span>
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Live token consumption, estimated API cost, latency & function-calling activity
            </p>
          </div>
        </div>

        {missingMetadataRequestCount > 0 && (
          <div
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300"
            title="Some Gemini API responses did not return usage metadata"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{missingMetadataRequestCount} call(s) missing metadata</span>
          </div>
        )}
      </div>

      {/* Grid of Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3.5">
        {/* Metric 1: Tokens */}
        <div className="p-3 rounded-lg bg-white dark:bg-surface-900/80 border dark:border-white/5 border-slate-200/70">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs">
            <span className="font-medium flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-brand-500" /> Total Tokens
            </span>
            <span className="text-[11px] font-mono text-slate-400">auth</span>
          </div>
          <div className="text-xl font-bold dark:text-white text-slate-900 mt-1">
            {totalTokens.toLocaleString()}
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap gap-x-2">
            <span>In: <strong className="text-slate-700 dark:text-slate-200">{inputTokens.toLocaleString()}</strong></span>
            <span>Out: <strong className="text-slate-700 dark:text-slate-200">{outputTokens.toLocaleString()}</strong></span>
          </div>
          {(Boolean(thoughtsTokens) || Boolean(cachedContentTokens) || Boolean(toolUsePromptTokens)) && (
            <div className="mt-1 pt-1 border-t dark:border-white/5 border-slate-100 text-[10px] text-slate-400 dark:text-slate-500 flex flex-wrap gap-1.5">
              {Boolean(thoughtsTokens) && <span>Thinking: {thoughtsTokens?.toLocaleString()}</span>}
              {Boolean(cachedContentTokens) && <span>Cached: {cachedContentTokens?.toLocaleString()}</span>}
              {Boolean(toolUsePromptTokens) && <span>Tool prompts: {toolUsePromptTokens?.toLocaleString()}</span>}
            </div>
          )}
        </div>

        {/* Metric 2: Estimated Cost */}
        <div className="p-3 rounded-lg bg-white dark:bg-surface-900/80 border dark:border-white/5 border-slate-200/70">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs">
            <span className="font-medium flex items-center gap-1.5">
              <Coins className="w-3.5 h-3.5 text-emerald-500" /> Estimated Cost
            </span>
          </div>
          <div
            className={clsx(
              'text-xl font-bold mt-1',
              costDisplay.isAvailable
                ? 'dark:text-emerald-400 text-emerald-600'
                : 'text-slate-500 dark:text-slate-400 text-sm'
            )}
          >
            {costDisplay.text}
          </div>
          <p
            className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate"
            title={costDisplay.subtitle}
          >
            {costDisplay.isAvailable ? 'Est. API Cost (USD)' : 'Pricing unavailable'}
          </p>
        </div>

        {/* Metric 3: Latency */}
        <div className="p-3 rounded-lg bg-white dark:bg-surface-900/80 border dark:border-white/5 border-slate-200/70">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs">
            <span className="font-medium flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-blue-500" /> LLM Latency
            </span>
          </div>
          <div className="text-xl font-bold dark:text-white text-slate-900 mt-1">
            {formatMs(totalLatencyMs)}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            Avg: <strong className="text-slate-700 dark:text-slate-200">{formatMs(avgLatencyMs)}</strong> / call
          </p>
        </div>

        {/* Metric 4: Function Calls & Requests */}
        <div className="p-3 rounded-lg bg-white dark:bg-surface-900/80 border dark:border-white/5 border-slate-200/70">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-xs">
            <span className="font-medium flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-purple-500" /> Function Calls
            </span>
            <span className="text-[11px] font-mono text-slate-400">
              {geminiRequestCount} reqs
            </span>
          </div>
          <div className="text-xl font-bold dark:text-white text-slate-900 mt-1">
            {functionCalls.executed}
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2">
            <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="w-3 h-3" /> {functionCalls.successful} ok
            </span>
            {functionCalls.failed > 0 && (
              <span className="flex items-center gap-0.5 text-red-600 dark:text-red-400 font-medium">
                <XCircle className="w-3 h-3" /> {functionCalls.failed} err
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Footer Disclaimer */}
      <div className="mt-3 pt-2 border-t dark:border-white/5 border-slate-100 flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500">
        <span className="flex items-center gap-1">
          <Info className="w-3 h-3" />
          <span>Cost is estimated from model pricing rates; actual billing is determined by Google Cloud.</span>
        </span>
        {estimatedCost?.verifiedDate && (
          <span className="hidden sm:inline">Rates verified: {estimatedCost.verifiedDate}</span>
        )}
      </div>
    </div>
  );
}
