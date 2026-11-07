/**
 * Safe Error Handling Utilities
 *
 * SECURITY: These utilities help prevent information disclosure through error messages.
 * Internal errors should be logged, but only generic messages sent to clients.
 */

import { log } from "./logger.js";

/**
 * Error categories for better handling and logging
 */
export enum ErrorCategory {
  VALIDATION = "validation",
  AUTHENTICATION = "authentication",
  AUTHORIZATION = "authorization",
  NOT_FOUND = "not_found",
  CONFLICT = "conflict",
  RATE_LIMIT = "rate_limit",
  EXTERNAL_SERVICE = "external_service",
  DATABASE = "database",
  INTERNAL = "internal",
}

/**
 * Client-safe error messages by category
 * These are the only messages that should be sent to clients
 */
const CLIENT_SAFE_MESSAGES: Record<ErrorCategory, string> = {
  [ErrorCategory.VALIDATION]: "Invalid request data",
  [ErrorCategory.AUTHENTICATION]: "Authentication required",
  [ErrorCategory.AUTHORIZATION]: "Permission denied",
  [ErrorCategory.NOT_FOUND]: "Resource not found",
  [ErrorCategory.CONFLICT]: "Resource conflict",
  [ErrorCategory.RATE_LIMIT]: "Too many requests, please try again later",
  [ErrorCategory.EXTERNAL_SERVICE]: "External service temporarily unavailable",
  [ErrorCategory.DATABASE]: "Service temporarily unavailable",
  [ErrorCategory.INTERNAL]: "An unexpected error occurred",
};

/**
 * Get a client-safe error message
 * Logs the full error internally but returns only a safe message
 *
 * @param error - The original error
 * @param category - Error category for appropriate message
 * @param context - Additional context for logging (NOT sent to client)
 */
export function getSafeErrorMessage(
  error: unknown,
  category: ErrorCategory = ErrorCategory.INTERNAL,
  context?: Record<string, unknown>
): string {
  // Log full error internally for debugging
  let errorMessage: string;
  if (error instanceof Error) {
    errorMessage = error.message;
  } else if (typeof error === "string") {
    errorMessage = error;
  } else {
    errorMessage = JSON.stringify(error);
  }
  const errorStack = error instanceof Error ? error.stack : undefined;

  log.error(`[SafeError:${category}] ${errorMessage}`, undefined, {
    category,
    stack: errorStack,
    ...context,
  });

  // Return only the safe message
  return CLIENT_SAFE_MESSAGES[category];
}

/**
 * Create a standardized error response object
 *
 * @param error - The original error
 * @param category - Error category
 * @param context - Additional context for logging
 * @param includeCode - Whether to include an error code
 */
export function createErrorResponse(
  error: unknown,
  category: ErrorCategory = ErrorCategory.INTERNAL,
  context?: Record<string, unknown>,
  includeCode: boolean = false
): { error: string; code?: string } {
  const message = getSafeErrorMessage(error, category, context);

  if (includeCode) {
    return { error: message, code: category.toUpperCase() };
  }

  return { error: message };
}

/**
 * Get HTTP status code for error category
 */
export function getStatusCodeForCategory(category: ErrorCategory): number {
  switch (category) {
    case ErrorCategory.VALIDATION:
      return 400;
    case ErrorCategory.AUTHENTICATION:
      return 401;
    case ErrorCategory.AUTHORIZATION:
      return 403;
    case ErrorCategory.NOT_FOUND:
      return 404;
    case ErrorCategory.CONFLICT:
      return 409;
    case ErrorCategory.RATE_LIMIT:
      return 429;
    case ErrorCategory.EXTERNAL_SERVICE:
    case ErrorCategory.DATABASE:
      return 503;
    case ErrorCategory.INTERNAL:
    default:
      return 500;
  }
}

/**
 * Check if an error message is safe to expose to clients
 * Only allows very generic, pre-approved messages
 */
export function isMessageSafeForClient(message: string): boolean {
  const safePatterns = [
    /^not found$/i,
    /^invalid request$/i,
    /^permission denied$/i,
    /^authentication required$/i,
    /^rate limit exceeded$/i,
    /^validation failed$/i,
    /^resource .+ not found$/i,
    /^.+ is required$/i,
    /^invalid .+ format$/i,
  ];

  return safePatterns.some(pattern => pattern.test(message));
}

/**
 * Sanitize an error message for client response
 * If message doesn't match safe patterns, return generic message
 */
export function sanitizeErrorMessage(
  message: string,
  fallback: string = "An error occurred"
): string {
  if (isMessageSafeForClient(message)) {
    return message;
  }
  return fallback;
}

/**
 * Sanitize a value before interpolating into log strings (CWE-134 / log injection).
 * Strips newlines, tabs, and carriage returns that could forge log entries,
 * and truncates to 200 characters to prevent log flooding.
 */
export function safeLogValue(val: unknown): string {
  const str = typeof val === "string" ? val : String(val ?? "");
  return str.replace(/[\r\n\t]/g, " ").slice(0, 200);
}
