/**
 * Utilities for sanitizing log messages and error outputs to prevent
 * accidental leakage of customer PII (names, emails, phone numbers)
 * or security credentials (API keys, authorization tokens).
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(\+\d{1,4}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{3,5}/g;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const GEMINI_KEY_REGEX = /AIza[0-9A-Za-z-_]{35}/g;
const GENERIC_KEY_REGEX = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9\-._~+/]+['"]?/gi;

/**
 * Sanitizes a message by replacing sensitive PII and secrets with safe placeholders.
 */
export function sanitizeLogMessage(message: unknown): string {
  if (message == null) return '';
  const text = typeof message === 'string' ? message : String(message);

  return text
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(PHONE_REGEX, '[REDACTED_PHONE]')
    .replace(BEARER_REGEX, 'Bearer [REDACTED_TOKEN]')
    .replace(GEMINI_KEY_REGEX, '[REDACTED_GEMINI_KEY]')
    .replace(GENERIC_KEY_REGEX, '$1: [REDACTED_SECRET]');
}

/**
 * Safe error message extractor that never includes stack traces or raw data.
 */
export function getSafeErrorMessage(err: unknown, fallback: string = 'An error occurred'): string {
  if (err instanceof Error) {
    const raw = err.message.split('\n')[0] || fallback;
    return sanitizeLogMessage(raw);
  }
  return fallback;
}
