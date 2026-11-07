/**
 * Octypo Secrets Manager
 * Encrypted storage for API keys and sensitive configuration
 *
 * Usage:
 * 1. Run: npx tsx server/octypo/config/secrets.ts --setup
 * 2. Enter your API keys when prompted
 * 3. Keys are encrypted with AES-256-GCM and stored in .octypo-secrets.enc
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// Encryption settings
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 64;
const ITERATIONS = 100000;

// File paths
const SECRETS_FILE = process.env.OCTYPO_SECRETS_FILE || ".octypo-secrets.enc";
const SECRETS_PATH = path.join(process.cwd(), SECRETS_FILE);

export interface OctypoSecrets {
  // Primary providers
  anthropic?: {
    apiKey?: string;
    apiKeys?: string[]; // Multiple keys for rotation
  };
  openai?: {
    apiKey?: string;
    apiKeys?: string[];
  };
  openrouter?: {
    apiKey?: string;
    apiKeys?: string[];
  };
  gemini?: {
    apiKey?: string;
    apiKeys?: string[];
  };
  groq?: {
    apiKey?: string;
  };
  mistral?: {
    apiKey?: string;
  };
  deepseek?: {
    apiKey?: string;
  };
  together?: {
    apiKey?: string;
  };
  perplexity?: {
    apiKey?: string;
  };

  // Monitoring & observability
  helicone?: {
    apiKey?: string;
    apiKeys?: string[];
  };

  // Optimization settings
  optimization?: {
    preferredProvider: string;
    fallbackOrder: string[];
    maxRetries: number;
    timeoutMs: number;
    rateLimitBuffer: number; // Percentage buffer before rate limit
  };

  // Metadata
  _meta?: {
    createdAt: string;
    updatedAt: string;
    version: number;
  };
}

/**
 * Derive encryption key from password using PBKDF2
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, "sha512");
}

/**
 * Encrypt secrets with AES-256-GCM
 */
export function encryptSecrets(secrets: OctypoSecrets, password: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const jsonData = JSON.stringify(secrets, null, 2);
  const encrypted = Buffer.concat([cipher.update(jsonData, "utf8"), cipher.final()]);

  const authTag = cipher.getAuthTag();

  // Format: salt (64) + iv (16) + authTag (16) + encrypted data
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt secrets with AES-256-GCM
 */
export function decryptSecrets(encryptedData: Buffer, password: string): OctypoSecrets {
  const salt = encryptedData.subarray(0, SALT_LENGTH);
  const iv = encryptedData.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = encryptedData.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  );
  const encrypted = encryptedData.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return JSON.parse(decrypted.toString("utf8"));
}

/**
 * Save encrypted secrets to file
 */
export function saveSecrets(secrets: OctypoSecrets, password: string): void {
  // Update metadata
  secrets._meta = {
    createdAt: secrets._meta?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: (secrets._meta?.version || 0) + 1,
  };

  const encrypted = encryptSecrets(secrets, password);
  fs.writeFileSync(SECRETS_PATH, encrypted);

  // Set restrictive permissions (owner read/write only)
  try {
    fs.chmodSync(SECRETS_PATH, 0o600);
  } catch (e) {
    // Windows doesn't support chmod - this is expected and safe to ignore
    console.error("[Secrets] chmod not supported on this platform:", e);
  }

  console.info(`✅ Secrets saved to ${SECRETS_FILE}`);
}

/**
 * Load and decrypt secrets from file
 */
export function loadSecrets(password: string): OctypoSecrets | null {
  if (!fs.existsSync(SECRETS_PATH)) {
    return null;
  }

  try {
    const encrypted = fs.readFileSync(SECRETS_PATH);
    return decryptSecrets(encrypted, password);
  } catch {
    console.error("❌ Failed to decrypt secrets. Wrong password?");
    return null;
  }
}

/**
 * Check if secrets file exists
 */
export function secretsExist(): boolean {
  return fs.existsSync(SECRETS_PATH);
}

/**
 * Get password from environment or prompt
 */
export function getSecretsPassword(): string {
  // First check environment variable
  const envPassword = process.env.OCTYPO_SECRETS_PASSWORD;
  if (envPassword) {
    return envPassword;
  }

  // Require explicit password in all environments
  throw new Error(
    "OCTYPO_SECRETS_PASSWORD environment variable is required. " +
      "Set it via: export OCTYPO_SECRETS_PASSWORD=<your-secret>"
  );
}

/**
 * Load secrets into environment variables (for EngineRegistry compatibility)
 */
export function loadSecretsToEnv(password?: string): boolean {
  const pwd = password || getSecretsPassword();
  const secrets = loadSecrets(pwd);

  if (!secrets) {
    return false;
  }

  // Provider name to env var prefix mapping
  const providerEnvMap: Array<{ provider: string; envPrefix: string }> = [
    { provider: "anthropic", envPrefix: "ANTHROPIC" },
    { provider: "openai", envPrefix: "OPENAI" },
    { provider: "openrouter", envPrefix: "OPENROUTER" },
    { provider: "gemini", envPrefix: "GEMINI" },
    { provider: "groq", envPrefix: "GROQ" },
    { provider: "mistral", envPrefix: "MISTRAL" },
    { provider: "deepseek", envPrefix: "DEEPSEEK" },
    { provider: "together", envPrefix: "TOGETHER" },
    { provider: "perplexity", envPrefix: "PERPLEXITY" },
    { provider: "helicone", envPrefix: "HELICONE" },
  ];

  for (const { provider, envPrefix } of providerEnvMap) {
    const providerSecrets = (secrets as any)[provider];
    if (providerSecrets?.apiKey) {
      process.env[`${envPrefix}_API_KEY`] = providerSecrets.apiKey;
    }
    if (providerSecrets?.apiKeys) {
      providerSecrets.apiKeys.forEach((key: string, i: number) => {
        process.env[`${envPrefix}_API_KEY_${i + 1}`] = key;
      });
    }
  }

  return true;
}

/**
 * Interactive CLI for setting up secrets
 */
async function interactiveSetup(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, resolve);
    });
  };

  const questionHidden = (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      process.stdout.write(prompt);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode?.(true);
      stdin.resume();

      let input = "";
      const onData = (char: Buffer) => {
        const c = char.toString();
        if (c === "\n" || c === "\r") {
          stdin.setRawMode?.(wasRaw);
          stdin.removeListener("data", onData);
          stdin.pause();
          process.stdout.write("\n");
          resolve(input);
        } else if (c === "\u0003") {
          // Ctrl+C
          process.exit();
        } else if (c === "\u007F") {
          // Backspace
          input = input.slice(0, -1);
          process.stdout.clearLine?.(0);
          process.stdout.cursorTo?.(0);
          process.stdout.write(prompt + "*".repeat(input.length));
        } else {
          input += c;
          process.stdout.write("*");
        }
      };

      stdin.on("data", onData);
    });
  };

  console.info("\n🔐 Octypo Secrets Setup\n");
  console.info("This will create an encrypted secrets file for your API keys.");
  console.info("The file will be encrypted with AES-256-GCM.\n");

  // Get or create password
  let password: string;
  if (secretsExist()) {
    password = await questionHidden("Enter existing password: ");
    const existing = loadSecrets(password);
    if (!existing) {
      console.info("❌ Wrong password. Exiting.");
      rl.close();
      return;
    }
    console.info("✅ Loaded existing secrets\n");
  } else {
    password = await questionHidden("Create a password: ");
    const confirm = await questionHidden("Confirm password: ");
    if (password !== confirm) {
      console.info("❌ Passwords do not match. Exiting.");
      rl.close();
      return;
    }
    console.info("");
  }

  // Load existing or create new
  const secrets: OctypoSecrets = loadSecrets(password) || {};

  console.info("Enter API keys (leave empty to skip):\n");

  // Collect API keys for all providers
  const providers = [
    "anthropic",
    "openai",
    "openrouter",
    "gemini",
    "groq",
    "mistral",
    "deepseek",
    "together",
    "perplexity",
    "helicone",
  ];

  for (const provider of providers) {
    const existing = (secrets as any)[provider]?.apiKey;
    const display = existing ? "****" + existing.slice(-4) : "not set";
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    const key = await question(`${label} API Key [${display}]: `);
    if (key) {
      (secrets as any)[provider] = { ...(secrets as any)[provider], apiKey: key };
    }
  }

  // Optimization settings
  await collectOptimizationSettings(secrets, question);

  // Save
  saveSecrets(secrets, password);

  // Print summary
  printSetupSummary(secrets, providers);

  rl.close();
}

function printSetupSummary(secrets: OctypoSecrets, providers: string[]): void {
  console.info("\n📋 Summary:");
  for (const provider of providers) {
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    const hasKey = !!(secrets as any)[provider]?.apiKey;
    console.info(`   ${label}: ${hasKey ? "✅" : "❌"}`);
  }
  console.info("\n🚀 To use in production:");
  console.info("   export OCTYPO_SECRETS_PASSWORD=<your-secret>");
  console.info("\n✅ Setup complete!\n");
}

async function collectOptimizationSettings(
  secrets: OctypoSecrets,
  question: (prompt: string) => Promise<string>
): Promise<void> {
  console.info("\n⚙️  Optimization Settings:\n");

  const preferredProvider = await question(
    `Preferred Provider [${secrets.optimization?.preferredProvider || "anthropic"}]: `
  );

  secrets.optimization = {
    preferredProvider: preferredProvider || secrets.optimization?.preferredProvider || "anthropic",
    fallbackOrder: secrets.optimization?.fallbackOrder || [
      "openrouter",
      "gemini",
      "groq",
      "openai",
    ],
    maxRetries: secrets.optimization?.maxRetries || 3,
    timeoutMs: secrets.optimization?.timeoutMs || 30000,
    rateLimitBuffer: secrets.optimization?.rateLimitBuffer || 10,
  };
}

// CLI entry point - check if running directly
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("secrets.ts") ||
  process.argv[1]?.includes("setup-octypo-secrets");

if (isMainModule) {
  const args = new Set(process.argv.slice(2));

  if (args.has("--setup") || args.has("-s")) {
    interactiveSetup().catch(console.error);
  } else if (args.has("--verify") || args.has("-v")) {
    const password = process.env.OCTYPO_SECRETS_PASSWORD || getSecretsPassword();
    const secrets = loadSecrets(password);
    if (secrets) {
      console.info("✅ Secrets file valid");
      console.info(`   Version: ${secrets._meta?.version}`);
      console.info(`   Updated: ${secrets._meta?.updatedAt}`);
    } else {
      console.info("❌ Could not load secrets");
      process.exit(1);
    }
  } else if (args.has("--export-env")) {
    // Export as environment variables (for debugging only)
    const password = process.env.OCTYPO_SECRETS_PASSWORD || getSecretsPassword();
    if (loadSecretsToEnv(password)) {
      console.info("✅ Secrets loaded to environment");
    } else {
      console.info("❌ Could not load secrets");
      process.exit(1);
    }
  } else {
    console.info("Octypo Secrets Manager\n");
    console.info("Usage:");
    console.info("  npx tsx server/octypo/config/secrets.ts --setup    Interactive setup");
    console.info("  npx tsx server/octypo/config/secrets.ts --verify   Verify secrets file");
    console.info("  npx tsx server/octypo/config/secrets.ts --export-env  Load to env vars");
    console.info("\nEnvironment:");
    console.info("  OCTYPO_SECRETS_PASSWORD  Password for encryption/decryption");
  }
}
