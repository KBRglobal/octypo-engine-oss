/**
 * Octypo Module - Autonomous Content Intelligence System
 *
 * Zero-touch content pipeline:
 * RSS → Gate1 (Selection) → Writer → Gate2 (Approval) → Publish
 *
 * Components:
 * - Config: Encrypted secrets management
 * - Gatekeeper: Intelligent content selection and approval
 * - RSS Reader: Feed aggregation and processing
 */

// Core types
export * from "./types.js";

// Configuration (encrypted secrets)
export { initializeOctypoConfig, loadSecretsToEnv, secretsExist } from "./config/index.js";

// Gatekeeper (Gate 1 & Gate 2)
export {
  runGatekeeperPipeline,
  initializeGatekeeper,
  getGate1Selector,
  getGate2Approver,
  getDeduplicationEngine,
  getGatekeeperOrchestrator,
} from "./gatekeeper/index.js";

// Agent system
export { BaseAgent, AgentRegistry, MessageBus } from "./agents/base-agent.js";
export {
  WriterAgent,
  initializeWriterAgents,
  getWriterForCategory,
} from "./agents/writer-agents.js";
export {
  ValidatorAgent,
  initializeValidatorAgents,
  getValidators,
} from "./agents/validator-agents.js";

// RSS system
export { rssReader, isSensitiveTopic } from "./rss-reader.js";
export type { FeedItem, RSSFeedConfig, FetchResult } from "./rss-reader.js";

// Quality scoring
export { calculateQuality108Score, getGrade } from "./quality/quality-108.js";

// State management
export { octypoState } from "./state.js";

// Orchestration
export { OctypoOrchestrator, getOctypoOrchestrator } from "./orchestration/orchestrator.js";
export {
  buildLongFormPrompt,
  buildNewsArticlePrompt,
  buildCorrectionPrompt,
  AI_BANNED_PHRASES,
} from "./prompts/content-prompts.js";

// ============================================
// OCTYPO SYSTEM INITIALIZATION
// ============================================

/**
 * Initialize the complete Octypo system
 * Call this during server startup
 */
export async function initializeOctypo(): Promise<boolean> {
  // Step 1: Load encrypted secrets (if available)
  try {
    const { initializeOctypoConfig, secretsExist } = await import("./config/index.js");
    if (secretsExist()) {
      initializeOctypoConfig();
    }
  } catch {
    // Secrets module not configured, using env vars - this is acceptable
    void 0;
  }

  // Step 2: Initialize RSS reader
  try {
    const { rssReader: rssReaderModule } = await import("./rss-reader.js");
    await rssReaderModule.initialize();
  } catch (error) {
    console.error("[Octypo] RSS reader initialization failed:", error);
  }

  // Step 3: Initialize Gatekeeper job handlers
  try {
    const { initializeGatekeeper } = await import("./gatekeeper/index.js");
    await initializeGatekeeper();
  } catch (error) {
    console.error("[Octypo] Gatekeeper initialization failed:", error);
  }

  return true;
}

/**
 * Run the autonomous content pipeline
 * @param maxItems Maximum items to process in this run
 */
export async function runOctypoPipeline(maxItems: number = 10): Promise<void> {
  const { runGatekeeperPipeline } = await import("./gatekeeper/index.js");
  await runGatekeeperPipeline(maxItems);
}
