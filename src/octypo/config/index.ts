/**
 * Octypo Configuration Module
 *
 * Centralized configuration for the Octypo autonomous content system.
 * Includes encrypted secrets management and optimization settings.
 */

// Import for local use
import { secretsExist as _secretsExist, loadSecretsToEnv as _loadSecretsToEnv } from "./secrets.js";

// Type export (interface)
export type { OctypoSecrets } from "./secrets.js";

// Value exports (functions)
export {
  encryptSecrets,
  decryptSecrets,
  saveSecrets,
  loadSecrets,
  secretsExist,
  getSecretsPassword,
  loadSecretsToEnv,
} from "./secrets.js";

/**
 * Initialize Octypo configuration
 * Call this at server startup to load encrypted secrets
 */
export function initializeOctypoConfig(): boolean {
  if (!_secretsExist()) {
    return false;
  }

  try {
    const loaded = _loadSecretsToEnv();
    if (loaded) {
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.error("[Octypo Config] Error loading secrets:", error);
    return false;
  }
}
