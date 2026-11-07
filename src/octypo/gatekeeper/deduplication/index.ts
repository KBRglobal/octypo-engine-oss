/**
 * Content Deduplication Module
 * Uses Locality Sensitive Hashing (LSH) for efficient duplicate detection
 *
 * Research-backed: 85% similarity threshold is the industry standard
 * for near-duplicate detection in news content.
 */

export { DeduplicationEngine, getDeduplicationEngine } from "./lsh-engine.js";
export { generateFingerprint, generateMinHash, calculateJaccardSimilarity } from "./fingerprint.js";
export { findSimilarContent, isDuplicate, SIMILARITY_THRESHOLD } from "./similarity.js";
