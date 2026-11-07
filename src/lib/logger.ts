/**
 * Centralized Logging Service
 * Uses Pino for structured, high-performance logging
 */

import pino from "pino";
import type { Request, Response, NextFunction } from "express";

// Environment configuration
const isProduction = process.env.NODE_ENV === "production";
const logLevel = process.env.LOG_LEVEL || (isProduction ? "info" : "debug");

// Create the logger instance
const transport = isProduction
  ? undefined // JSON output in production
  : {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };

export const logger = pino({
  level: logLevel,
  transport,
  base: {
    env: process.env.NODE_ENV || "development",
  },
  // Redact sensitive fields
  redact: {
    paths: [
      "password",
      "token",
      "authorization",
      "cookie",
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
    ],
    censor: "[REDACTED]",
  },
});

/**
 * Create a child logger with additional context
 */
export function createLogger(name: string, meta?: Record<string, unknown>) {
  return logger.child({ module: name, ...meta });
}

/**
 * Express request logging middleware
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();
  const requestId = generateRequestId();

  // Attach request ID for tracing
  req.requestId = requestId;

  // Log request
  logger.info({
    type: "request",
    requestId,
    method: req.method,
    url: req.originalUrl,
    userAgent: req.headers["user-agent"],
    ip: req.ip || req.socket.remoteAddress,
  });

  // Log response on finish
  res.on("finish", () => {
    const duration = Date.now() - startTime;
    const logFn = res.statusCode >= 400 ? logger.warn : logger.info;

    logFn.call(logger, {
      type: "response",
      requestId,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
    });
  });

  next();
}

/**
 * Generate unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Log levels helper
 */
export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => logger.debug(data, msg),
  info: (msg: string, data?: Record<string, unknown>) => logger.info(data, msg),
  warn: (msg: string, data?: Record<string, unknown>) => logger.warn(data, msg),
  error: (msg: string, error?: unknown, data?: Record<string, unknown>) => {
    if (error instanceof Error) {
      logger.error({ ...data, err: error }, msg);
    } else {
      logger.error({ ...data, error }, msg);
    }
  },
  fatal: (msg: string, error?: unknown) => {
    if (error instanceof Error) {
      logger.fatal({ err: error }, msg);
    } else {
      logger.fatal({ error }, msg);
    }
  },
};

/**
 * Audit logger for security events
 */
export const auditLog = createLogger("audit");

export function logSecurityEvent(
  event: string,
  data: {
    userId?: string;
    ip?: string;
    action: string;
    resource?: string;
    success: boolean;
    details?: Record<string, unknown>;
  }
) {
  auditLog.info({
    type: "security",
    event,
    ...data,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Performance logger
 */
export const perfLog = createLogger("performance");

export function logPerformance(
  operation: string,
  durationMs: number,
  meta?: Record<string, unknown>
) {
  let level: "warn" | "info" | "debug";
  if (durationMs > 1000) {
    level = "warn";
  } else if (durationMs > 500) {
    level = "info";
  } else {
    level = "debug";
  }
  perfLog[level]({
    type: "performance",
    operation,
    durationMs,
    ...meta,
  });
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export default logger;
