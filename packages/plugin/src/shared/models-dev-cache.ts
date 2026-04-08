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

function loadModelsDevLimits(): Map<string, number> {
    const limits = new Map<string, number>();
    const filePath = getModelsJsonPath();

    try {
        if (!existsSync(filePath)) {
            return limits;
        }

        const raw = readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as Record<
            string,
            { models?: Record<string, { limit?: { context?: number } }> }
        >;

        for (const [providerId, provider] of Object.entries(data)) {
            if (!provider?.models || typeof provider.models !== "object") continue;
            for (const [modelId, model] of Object.entries(provider.models)) {
                const context = model?.limit?.context;
                if (typeof context === "number" && context > 0) {
                    limits.set(`${providerId}/${modelId}`, context);
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
