/**
 * Octypo Settings API
 * Simple encrypted settings storage in database
 */

import { db } from "../../db.js";
import { sql } from "drizzle-orm";
import * as crypto from "node:crypto";

// Encryption key from environment (or generate one)
const ENCRYPTION_KEY =
  process.env.OCTYPO_ENCRYPTION_KEY ||
  crypto
    .createHash("sha256")
    .update(process.env.DATABASE_URL || "octypo-default-key")
    .digest();

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(encrypted: string): string {
  const [ivHex, authTagHex, encryptedHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encryptedBuffer = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]).toString("utf8");
}

export interface OctypoSettings {
  // API Keys
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  geminiApiKey?: string;
  groqApiKey?: string;
  mistralApiKey?: string;
  deepseekApiKey?: string;
  togetherApiKey?: string;
  perplexityApiKey?: string;
  heliconeApiKey?: string;

  // Gatekeeper Settings
  preferredProvider?: string;
  seoWeight?: number;
  aeoWeight?: number;
  viralityWeight?: number;
  minScoreForS1?: number;
  minScoreForS2?: number;
  skipBelowScore?: number;

  // General
  enabled?: boolean;
  autoPublish?: boolean;
  maxDailyArticles?: number;
}

const SETTINGS_KEY = "octypo_settings";

// Ensure table exists
let tableChecked = false;
async function ensureTable(): Promise<void> {
  if (tableChecked) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    tableChecked = true;
  } catch (error) {
    // Table might already exist - this is expected
    console.error("[Octypo Settings] Table creation notice:", error);
    tableChecked = true;
  }
}

/**
 * Get all settings (decrypted)
 */
export async function getSettings(): Promise<OctypoSettings> {
  await ensureTable();
  try {
    const result = await db.execute(sql`
      SELECT value FROM system_settings WHERE key = ${SETTINGS_KEY}
    `);

    const row = (result as any)?.[0];
    if (!row?.value) {
      return getDefaultSettings();
    }

    const settings = JSON.parse(row.value);

    // Decrypt API keys
    const decrypted: OctypoSettings = { ...settings };
    const keyFields = [
      "anthropicApiKey",
      "openaiApiKey",
      "openrouterApiKey",
      "geminiApiKey",
      "groqApiKey",
      "mistralApiKey",
      "deepseekApiKey",
      "togetherApiKey",
      "perplexityApiKey",
      "heliconeApiKey",
    ];

    for (const field of keyFields) {
      if (settings[field]) {
        try {
          (decrypted as any)[field] = decrypt(settings[field]);
        } catch {
          // If decryption fails, might be stored unencrypted
          (decrypted as any)[field] = settings[field];
        }
      }
    }

    return decrypted;
  } catch (error) {
    console.error("[Octypo Settings] Error loading:", error);
    return getDefaultSettings();
  }
}

/**
 * Save settings (encrypts API keys)
 */
export async function saveSettings(settings: Partial<OctypoSettings>): Promise<boolean> {
  await ensureTable();
  try {
    // Get existing settings
    const existing = await getSettings();
    const merged = { ...existing, ...settings };

    // Encrypt API keys
    const toSave: any = { ...merged };
    const keyFields = [
      "anthropicApiKey",
      "openaiApiKey",
      "openrouterApiKey",
      "geminiApiKey",
      "groqApiKey",
      "mistralApiKey",
      "deepseekApiKey",
      "togetherApiKey",
      "perplexityApiKey",
      "heliconeApiKey",
    ];

    for (const field of keyFields) {
      if (toSave[field]) {
        toSave[field] = encrypt(toSave[field]);
      }
    }

    // Upsert to database
    await db.execute(sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (${SETTINGS_KEY}, ${JSON.stringify(toSave)}, NOW())
      ON CONFLICT (key) DO UPDATE SET
        value = ${JSON.stringify(toSave)},
        updated_at = NOW()
    `);

    // Also load to environment for immediate use
    loadSettingsToEnv(merged);

    return true;
  } catch (error) {
    console.error("[Octypo Settings] Error saving:", error);
    return false;
  }
}

/**
 * Load settings into environment variables
 */
export function loadSettingsToEnv(settings: OctypoSettings): void {
  if (settings.anthropicApiKey) process.env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
  if (settings.openaiApiKey) process.env.OPENAI_API_KEY = settings.openaiApiKey;
  if (settings.openrouterApiKey) process.env.OPENROUTER_API_KEY = settings.openrouterApiKey;
  if (settings.geminiApiKey) process.env.GEMINI_API_KEY = settings.geminiApiKey;
  if (settings.groqApiKey) process.env.GROQ_API_KEY = settings.groqApiKey;
  if (settings.mistralApiKey) process.env.MISTRAL_API_KEY = settings.mistralApiKey;
  if (settings.deepseekApiKey) process.env.DEEPSEEK_API_KEY = settings.deepseekApiKey;
  if (settings.togetherApiKey) process.env.TOGETHER_API_KEY = settings.togetherApiKey;
  if (settings.perplexityApiKey) process.env.PERPLEXITY_API_KEY = settings.perplexityApiKey;
  if (settings.heliconeApiKey) process.env.HELICONE_API_KEY = settings.heliconeApiKey;
}

/**
 * Initialize settings on server startup
 */
export async function initializeSettings(): Promise<void> {
  try {
    const settings = await getSettings();
    loadSettingsToEnv(settings);
  } catch {
    // Using environment variables as fallback - this is expected behavior
    void 0;
  }
}

/**
 * Get settings for display (masked API keys)
 */
export async function getSettingsForDisplay(): Promise<
  OctypoSettings & { _masked: Record<string, boolean> }
> {
  const settings = await getSettings();
  const masked: Record<string, boolean> = {};

  const keyFields = [
    "anthropicApiKey",
    "openaiApiKey",
    "openrouterApiKey",
    "geminiApiKey",
    "groqApiKey",
    "mistralApiKey",
    "deepseekApiKey",
    "togetherApiKey",
    "perplexityApiKey",
    "heliconeApiKey",
  ];

  const display: any = { ...settings };
  for (const field of keyFields) {
    if (display[field]) {
      masked[field] = true;
      // Show only last 4 chars
      display[field] = "••••••••" + display[field].slice(-4);
    }
  }

  return { ...display, _masked: masked };
}

function getDefaultSettings(): OctypoSettings {
  return {
    preferredProvider: "anthropic",
    seoWeight: 40,
    aeoWeight: 35,
    viralityWeight: 25,
    minScoreForS1: 80,
    minScoreForS2: 60,
    skipBelowScore: 40,
    enabled: true,
    autoPublish: false,
    maxDailyArticles: 50,
  };
}
