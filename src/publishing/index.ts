/**
 * The publishing layer's public surface.
 *
 * Nothing here imports `src/db.ts` at module load — the Postgres reference store
 * pulls it in lazily — so the whole layer stays importable, and unit-testable,
 * without a database.
 */

export type {
  Degradation,
  MediaRef,
  NormalisedArticle,
  PublishErrorCode,
  PublishOutcome,
  PublishingTarget,
  RemoteRef,
  TargetCapabilities,
  TargetCheck,
  TargetFeature,
  TaxonomyTerm,
} from "./types.js";
export { capabilities, failed, FULL_CAPABILITIES, RETRYABLE } from "./types.js";

export { describeDegradation, formatDegradation, hasDegradation } from "./capabilities.js";
export {
  contentHashOf,
  escapeHtml,
  mediaFilename,
  normaliseArticle,
  renderBlock,
  renderBlocksToHtml,
  termFromSlug,
  toStructuredData,
  type ArticleSource,
  type NormaliseOptions,
} from "./normalise.js";
export {
  InMemoryRemoteRefStore,
  PostgresRemoteRefStore,
  publishingTargetRefs,
  type RemoteRefStore,
} from "./remote-ref-store.js";
export {
  defaultDeliveryOptions,
  deliver,
  deliverArticle,
  resolveTargets,
  type DeliveryOptions,
  type DeliveryReport,
  type DeliveryResult,
} from "./registry.js";
export { WordPressTarget, type WordPressConfig } from "./wordpress.js";
export { WebhookTarget, serialiseArticleEvent, type WebhookConfig } from "./webhook.js";
export { AstroGitTarget, type AstroGitArea, type AstroGitConfig, type AstroGitCopy } from "./astro-git.js";
export { textDirection, type TextDirection } from "./text-direction.js";
