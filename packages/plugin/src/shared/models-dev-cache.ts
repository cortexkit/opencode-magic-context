/**
 * Read model context limits from OpenCode's models.dev cache file.
 *
 * OpenCode fetches model metadata from models.dev and caches it at:
 *   <xdg_cache>/opencode/models.json
 *
 * This file contains per-provider, per-model data including `limit.context`.
 * We read it lazily and refresh periodically to get accurate context limits
 * without requiring user configuration.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { sessionLog } from "./logger";

/** Resolved context limits keyed by "providerID/modelID" */
let cachedLimits: Map<string, number> | null = null;
let lastLoadAttempt = 0;
const RELOAD_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes, matches OpenCode's TTL

function getModelsJsonPath(): string {
    const xdgCache = process.env.XDG_CACHE_HOME;
    const os = platform();

    let cacheBase: string;
    if (xdgCache) {
        cacheBase = xdgCache;
    } else if (os === "win32") {
        cacheBase = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    } else {
        cacheBase = join(homedir(), ".cache");
    }

    return join(cacheBase, "opencode", "models.json");
}

function getOpencodeConfigPath(): string | null {
    const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    const configDir = envDir
        ? envDir
        : platform() === "win32"
          ? join(homedir(), ".config", "opencode")
          : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

    // Check jsonc first, then json (matches OpenCode's own lookup order)
    const jsonc = join(configDir, "opencode.jsonc");
    if (existsSync(jsonc)) return jsonc;
    const json = join(configDir, "opencode.json");
    if (existsSync(json)) return json;
    return null;
}

function loadModelsDevLimits(): Map<string, number> {
    const limits = new Map<string, number>();

    // 1. Load from OpenCode's models.dev cache (base layer — all known public models)
    const modelsJsonPath = getModelsJsonPath();
    try {
        if (existsSync(modelsJsonPath)) {
            const raw = readFileSync(modelsJsonPath, "utf-8");
            const data = JSON.parse(raw) as Record<
                string,
                {
                    models?: Record<
                        string,
                        {
                            limit?: { context?: number };
                            experimental?: { modes?: Record<string, unknown> };
                        }
                    >;
                }
            >;

            for (const [providerId, provider] of Object.entries(data)) {
                if (!provider?.models || typeof provider.models !== "object") continue;
                for (const [modelId, model] of Object.entries(provider.models)) {
                    const context = model?.limit?.context;
                    if (typeof context === "number" && context > 0) {
                        limits.set(`${providerId}/${modelId}`, context);
                        // OpenCode creates derived model IDs from experimental.modes
                        // e.g. gpt-5.4 + modes.fast → gpt-5.4-fast (inherits parent limit)
                        const modes = model?.experimental?.modes;
                        if (modes && typeof modes === "object") {
                            for (const mode of Object.keys(modes)) {
                                limits.set(`${providerId}/${modelId}-${mode}`, context);
                            }
                        }
                    }
                }
            }
        }
    } catch (error) {
        sessionLog(
            "global",
            "models-dev-cache: failed to read models.json:",
            error instanceof Error ? error.message : String(error),
        );
    }

    // 2. Overlay custom provider models from OpenCode config (higher priority).
    // Users define custom/proxy models via provider.<id>.models.<name>.limit.context
    // in opencode.json(c). These override models.dev entries for the same key.
    try {
        const configPath = getOpencodeConfigPath();
        if (configPath && existsSync(configPath)) {
            let raw = readFileSync(configPath, "utf-8");
            // Strip JSONC comments (single-line only — sufficient for OpenCode configs)
            raw = raw.replace(/\/\/.*$/gm, "");
            const config = JSON.parse(raw) as {
                provider?: Record<
                    string,
                    { models?: Record<string, { limit?: { context?: number } }> }
                >;
            };

            if (config.provider && typeof config.provider === "object") {
                for (const [providerId, provider] of Object.entries(config.provider)) {
                    if (!provider?.models || typeof provider.models !== "object") continue;
                    for (const [modelId, model] of Object.entries(provider.models)) {
                        const context = model?.limit?.context;
                        if (typeof context === "number" && context > 0) {
                            limits.set(`${providerId}/${modelId}`, context);
                        }
                    }
                }
            }
        }
    } catch (error) {
        sessionLog(
            "global",
            "models-dev-cache: failed to read opencode config for custom models:",
            error instanceof Error ? error.message : String(error),
        );
    }

    return limits;
}

/**
 * Get the context limit for a specific provider/model from OpenCode's models.dev cache.
 * Returns undefined if the model is not found or the cache is unavailable.
 * Results are cached in memory and refreshed every 5 minutes.
 */
export function getModelsDevContextLimit(providerID: string, modelID: string): number | undefined {
    const now = Date.now();

    if (!cachedLimits || now - lastLoadAttempt > RELOAD_INTERVAL_MS) {
        lastLoadAttempt = now;
        cachedLimits = loadModelsDevLimits();
    }

    return cachedLimits.get(`${providerID}/${modelID}`);
}

/** Clear the in-memory cache (for testing) */
export function clearModelsDevCache(): void {
    cachedLimits = null;
    lastLoadAttempt = 0;
}
