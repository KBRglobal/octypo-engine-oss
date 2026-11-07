/**
 * AI Module Utility Functions
 */

import { randomUUID } from "node:crypto";

/**
 * Generate a unique block ID for content blocks
 */
export function generateBlockId(): string {
  return randomUUID().slice(0, 7);
}

/**
 * Generate a URL-safe slug from a title
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, "")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .trim();
}
