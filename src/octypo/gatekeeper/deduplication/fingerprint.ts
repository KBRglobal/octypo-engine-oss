/**
 * Document Fingerprinting using MinHash
 *
 * MinHash is a probabilistic technique for quickly estimating Jaccard similarity
 * between sets. Combined with LSH, it enables O(1) duplicate lookup instead of O(n).
 *
 * Based on: Broder, A. Z. (1997). "On the resemblance and containment of documents"
 */

import { createHash } from "node:crypto";

// Number of hash functions for MinHash signature
const NUM_HASHES = 128;

// Large prime for hash function
const PRIME = 2147483647;

// Pre-computed coefficients for hash functions (a, b pairs)
const HASH_COEFFICIENTS: Array<[number, number]> = [];
for (let i = 0; i < NUM_HASHES; i++) {
  HASH_COEFFICIENTS.push([Math.floor(Math.random() * PRIME), Math.floor(Math.random() * PRIME)]);
}

/**
 * Normalize text for fingerprinting
 * - Lowercase
 * - Remove punctuation
 * - Remove extra whitespace
 * - Remove stop words (basic set)
 */
function normalizeText(text: string): string {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "as",
    "if",
    "then",
    "than",
  ]);

  return text
    .toLowerCase()
    .replaceAll(/[^\w\s]/g, " ") // Remove punctuation
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .join(" ")
    .trim();
}

/**
 * Generate n-grams (shingles) from text
 * Using 3-grams (trigrams) for better accuracy
 */
function generateShingles(text: string, n: number = 3): Set<string> {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/);
  const shingles = new Set<string>();

  if (words.length < n) {
    // For very short text, use the whole thing
    shingles.add(normalized);
    return shingles;
  }

  for (let i = 0; i <= words.length - n; i++) {
    const shingle = words.slice(i, i + n).join(" ");
    shingles.add(shingle);
  }

  return shingles;
}

/**
 * Hash a shingle to a 32-bit integer.
 * NOTE (CWE-916 suppression): MD5 is used here as a fast, non-cryptographic hash
 * to map text shingles to 32-bit integers for MinHash similarity estimation.
 * This is NOT used for password storage or authentication — it is a document
 * fingerprinting checksum where collision resistance is not a security requirement.
 */
function hashShingle(shingle: string): number {
  const hash = createHash("md5").update(shingle).digest();
  return hash.readUInt32LE(0);
}

/**
 * Generate MinHash signature for a document
 * Returns an array of NUM_HASHES minimum hash values
 */
export function generateMinHash(text: string): number[] {
  const shingles = generateShingles(text);
  const signature: number[] = new Array(NUM_HASHES).fill(Infinity);

  for (const shingle of shingles) {
    const shingleHash = hashShingle(shingle);

    // Apply each hash function and keep minimum
    for (let i = 0; i < NUM_HASHES; i++) {
      const [a, b] = HASH_COEFFICIENTS[i];
      const hashValue = (a * shingleHash + b) % PRIME;
      signature[i] = Math.min(signature[i], hashValue);
    }
  }

  // Replace Infinity with 0 for empty/very short documents
  return signature.map(v => (v === Infinity ? 0 : v));
}

/**
 * Generate a compact fingerprint string from MinHash signature
 * Used for database storage and quick lookup
 */
export function generateFingerprint(text: string): string {
  const minHash = generateMinHash(text);

  // Convert to hex string for compact storage
  const buffer = Buffer.alloc(NUM_HASHES * 4);
  for (let i = 0; i < NUM_HASHES; i++) {
    buffer.writeUInt32LE(minHash[i], i * 4);
  }

  return buffer.toString("base64");
}

/**
 * Parse fingerprint string back to MinHash signature
 */
export function parseFingerprint(fingerprint: string): number[] {
  const buffer = Buffer.from(fingerprint, "base64");
  const signature: number[] = [];

  for (let i = 0; i < NUM_HASHES; i++) {
    signature.push(buffer.readUInt32LE(i * 4));
  }

  return signature;
}

/**
 * Calculate Jaccard similarity from two MinHash signatures
 * Estimated as the fraction of hash functions that agree
 */
export function calculateJaccardSimilarity(sig1: number[], sig2: number[]): number {
  if (sig1.length !== sig2.length) {
    throw new Error("Signatures must have the same length");
  }

  let matches = 0;
  for (let i = 0; i < sig1.length; i++) {
    if (sig1[i] === sig2[i]) {
      matches++;
    }
  }

  return matches / sig1.length;
}

/**
 * Calculate similarity between two fingerprint strings
 */
export function calculateFingerprintSimilarity(fp1: string, fp2: string): number {
  const sig1 = parseFingerprint(fp1);
  const sig2 = parseFingerprint(fp2);
  return calculateJaccardSimilarity(sig1, sig2);
}

/**
 * Generate LSH bands for candidate filtering
 * Divides signature into bands for efficient lookup
 */
export function generateLSHBands(signature: number[], numBands: number = 16): string[] {
  const rowsPerBand = Math.floor(signature.length / numBands);
  const bands: string[] = [];

  for (let b = 0; b < numBands; b++) {
    const start = b * rowsPerBand;
    const end = start + rowsPerBand;
    const bandSlice = signature.slice(start, end);

    // Hash the band slice to create a bucket key.
    // NOTE (CWE-916 suppression): MD5 is used here as a fast hash to create LSH
    // bucket keys for duplicate detection — not for password or secret storage.
    const bandHash = createHash("md5").update(bandSlice.join(",")).digest("hex").substring(0, 16);

    bands.push(`band_${b}_${bandHash}`);
  }

  return bands;
}
