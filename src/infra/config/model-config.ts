import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ModelTier } from "../../domain/value/index.js";
import type { ThinkingLevelName } from "../../application/port/index.js";

// ---------------------------------------------------------------------------
// Schema types — these mirror the .deeplooper/models.json structure.
// ---------------------------------------------------------------------------

export interface TierBinding {
  /** Model id as recognised by pi's model registry (e.g. "deepseek/deepseek-v4-pro"). */
  model?: string;
  /** Thinking level override for this tier. */
  thinking?: ThinkingLevelName;
}

export type ProfileConfig = Partial<Record<ModelTier, TierBinding>>;

export interface ModelConfig {
  /** Name of the default profile to activate when no models: flag is supplied. */
  profile?: string;
  profiles?: Record<string, ProfileConfig>;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(".deeplooper", "models.json");

/**
 * Loads .deeplooper/models.json from the workspace root.
 *
 * - Missing file     → returns an empty config (all tiers fall back to pi default).
 * - Malformed JSON   → logs a warning and returns an empty config.
 * - Valid JSON       → returns the parsed config (partial shapes are fine; missing
 *                      keys mean "use pi default for that tier").
 */
export async function loadModelConfig(workspaceRoot: string, warn?: (message: string) => void): Promise<ModelConfig> {
  const filePath = path.join(workspaceRoot, CONFIG_PATH);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    // Missing file is normal — return empty config.
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn?.(`[deeplooper] .deeplooper/models.json must be a JSON object — ignoring.`);
      return {};
    }
    return coerceModelConfig(parsed as Record<string, unknown>);
  } catch {
    warn?.(`[deeplooper] .deeplooper/models.json contains invalid JSON — ignoring.`);
    return {};
  }
}

/**
 * Given a parsed ModelConfig and a resolved profile name (already accounting for
 * the models: flag and the file's own `profile` default), returns the active
 * ProfileConfig (or an empty object if neither exists).
 */
export function resolveProfile(config: ModelConfig, profileName: string | undefined): ProfileConfig {
  if (!profileName || !config.profiles) {
    return {};
  }
  return config.profiles[profileName] ?? {};
}

// ---------------------------------------------------------------------------
// Internal coercion — turns unknown JSON into a typed ModelConfig.
// ---------------------------------------------------------------------------

const VALID_TIERS = new Set<string>(["architect", "coding", "review", "utility"]);
const VALID_THINKING = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function coerceModelConfig(raw: Record<string, unknown>): ModelConfig {
  const config: ModelConfig = {};

  if (typeof raw.profile === "string" && raw.profile) {
    config.profile = raw.profile;
  }

  if (raw.profiles !== null && typeof raw.profiles === "object" && !Array.isArray(raw.profiles)) {
    const profiles: Record<string, ProfileConfig> = {};
    for (const [name, value] of Object.entries(raw.profiles as Record<string, unknown>)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        profiles[name] = coerceProfileConfig(value as Record<string, unknown>);
      }
    }
    config.profiles = profiles;
  }

  return config;
}

function coerceProfileConfig(raw: Record<string, unknown>): ProfileConfig {
  const profile: ProfileConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!VALID_TIERS.has(key)) continue;
    const tier = key as ModelTier;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      profile[tier] = coerceTierBinding(value as Record<string, unknown>);
    }
  }
  return profile;
}

function coerceTierBinding(raw: Record<string, unknown>): TierBinding {
  const binding: TierBinding = {};
  if (typeof raw.model === "string" && raw.model) {
    binding.model = raw.model;
  }
  if (typeof raw.thinking === "string" && VALID_THINKING.has(raw.thinking)) {
    binding.thinking = raw.thinking as ThinkingLevelName;
  }
  return binding;
}
