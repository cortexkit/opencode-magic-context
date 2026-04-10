import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "comment-json";
import { detectConflicts } from "../shared/conflict-detector";
import { type ConfigPaths, detectConfigPaths } from "./config-paths";
import { getOpenCodeVersion, isOpenCodeInstalled } from "./opencode-helpers";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY_WITH_VERSION = `${PLUGIN_NAME}@latest`;

export interface DiagnosticReport {
    timestamp: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    pluginVersion: string;
    opencodeInstalled: boolean;
    opencodeVersion: string | null;
    configPaths: ConfigPaths;
    opencodeConfigHasPlugin: boolean;
    tuiConfigHasPlugin: boolean;
    magicContextConfig: {
        exists: boolean;
        parseError?: string;
        flags: Record<string, unknown>;
    };
    pluginCache: {
        path: string;
        cached?: string;
        latest?: string;
    };
    storageDir: {
        path: string;
        exists: boolean;
        contextDbSizeBytes: number;
    };
    conflicts: {
        hasConflict: boolean;
        reasons: string[];
    };
    logFile: {
        path: string;
        exists: boolean;
        sizeKb: number;
    };
    historianDumps: {
        dir: string;
        count: number;
        recent: { name: string; ageMinutes: number; sizeKb: number }[];
    };
}

// ── Version + path helpers ──────────────────────────────────────────

function getSelfVersion(): string {
    // createRequire resolves relative to this module. In source layout this file
    // lives at src/cli/diagnostics.ts; in bundled layout at dist/cli.js.
    const require = createRequire(import.meta.url);
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            const pkg = require(relPath) as { version?: unknown };
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
                return pkg.version;
            }
        } catch {
            // Try next path.
        }
    }
    return "unknown";
}

function getOpenCodeCacheDir(): string {
    const xdgCache = process.env.XDG_CACHE_HOME;
    if (xdgCache) return join(xdgCache, "opencode");

    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
        return join(localAppData, "opencode");
    }
    return join(homedir(), ".cache", "opencode");
}

function getPluginCacheInfo(): { path: string; cached?: string; latest?: string } {
    const path = join(getOpenCodeCacheDir(), "packages", PLUGIN_ENTRY_WITH_VERSION);
    let cached: string | undefined;
    try {
        const installedPkgPath = join(
            path,
            "node_modules",
            "@cortexkit",
            "opencode-magic-context",
            "package.json",
        );
        if (existsSync(installedPkgPath)) {
            const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8")) as {
                version?: unknown;
            };
            cached = typeof pkg.version === "string" ? pkg.version : undefined;
        }
    } catch {
        cached = undefined;
    }
    return { path, cached, latest: getSelfVersion() };
}

function getStorageDir(): string {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(dataHome, "opencode", "storage", "plugin", "magic-context");
}

function fileSize(path: string): number {
    try {
        return existsSync(path) ? statSync(path).size : 0;
    } catch {
        return 0;
    }
}

// ── Sanitization ─────────────────────────────────────────────────────

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeString(value: string): string {
    const home = homedir();
    const username = userInfo().username;
    let sanitized = value;
    if (home) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(home), "g"), "~");
    }
    sanitized = sanitized.replace(/\/Users\/[^/]+\//g, "/Users/<USER>/");
    sanitized = sanitized.replace(/\/home\/[^/]+\//g, "/home/<USER>/");
    sanitized = sanitized.replace(/C:\\Users\\[^\\]+\\/g, "C:\\Users\\<USER>\\");
    if (username) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(username), "g"), "<USER>");
    }
    return sanitized;
}

function sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") return sanitizeString(value);
    if (Array.isArray(value)) return value.map(sanitizeValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]),
        );
    }
    return value;
}

// ── Config + plugin entry detection ────────────────────────────────

function readConfig(path: string): { value: Record<string, unknown> | null; error?: string } {
    if (!existsSync(path)) return { value: null };
    try {
        const raw = readFileSync(path, "utf-8");
        const value = parseJsonc(raw) as Record<string, unknown>;
        return { value };
    } catch (error) {
        return { value: null, error: error instanceof Error ? error.message : String(error) };
    }
}

function configHasPluginEntry(config: Record<string, unknown> | null): boolean {
    const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
    return plugins.some((entry) => {
        if (typeof entry !== "string") return false;
        if (entry === PLUGIN_NAME) return true;
        if (entry.startsWith(`${PLUGIN_NAME}@`)) return true;
        // Local dev paths
        if (entry.includes("opencode-magic-context")) return true;
        return false;
    });
}

// ── Historian dump enumeration ─────────────────────────────────────

function collectHistorianDumps(): DiagnosticReport["historianDumps"] {
    const dir = join(tmpdir(), "magic-context-historian");
    if (!existsSync(dir)) {
        return { dir, count: 0, recent: [] };
    }
    try {
        const entries = readdirSync(dir)
            .filter((name) => name.endsWith(".xml"))
            .map((name) => {
                const stat = statSync(join(dir, name));
                return {
                    name,
                    mtime: stat.mtimeMs,
                    sizeKb: Math.round(stat.size / 1024),
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        const now = Date.now();
        const recent = entries.slice(0, 3).map((entry) => ({
            name: entry.name,
            ageMinutes: Math.round((now - entry.mtime) / 60000),
            sizeKb: entry.sizeKb,
        }));
        return { dir, count: entries.length, recent };
    } catch {
        return { dir, count: 0, recent: [] };
    }
}

// ── Main entry ─────────────────────────────────────────────────────

export async function collectDiagnostics(): Promise<DiagnosticReport> {
    const pluginVersion = getSelfVersion();
    const configPaths = detectConfigPaths();
    const opencodeConfig = readConfig(configPaths.opencodeConfig);
    const tuiConfig = readConfig(configPaths.tuiConfig);
    const magicContextConfig = readConfig(configPaths.magicContextConfig);
    const storageDirPath = getStorageDir();
    const contextDbPath = join(storageDirPath, "context.db");

    const logPath = join(tmpdir(), "magic-context.log");
    const logFileSize = existsSync(logPath) ? statSync(logPath).size : 0;

    const conflictResult = detectConflicts(process.cwd());

    return {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pluginVersion,
        opencodeInstalled: isOpenCodeInstalled(),
        opencodeVersion: getOpenCodeVersion(),
        configPaths,
        opencodeConfigHasPlugin: configHasPluginEntry(opencodeConfig.value),
        tuiConfigHasPlugin: configHasPluginEntry(tuiConfig.value),
        magicContextConfig: {
            exists: existsSync(configPaths.magicContextConfig),
            ...(magicContextConfig.error ? { parseError: magicContextConfig.error } : {}),
            flags: (sanitizeValue(magicContextConfig.value ?? {}) as Record<string, unknown>) ?? {},
        },
        pluginCache: getPluginCacheInfo(),
        storageDir: {
            path: storageDirPath,
            exists: existsSync(storageDirPath),
            contextDbSizeBytes: fileSize(contextDbPath),
        },
        conflicts: {
            hasConflict: conflictResult.hasConflict,
            reasons: conflictResult.reasons,
        },
        logFile: {
            path: logPath,
            exists: existsSync(logPath),
            sizeKb: Math.round(logFileSize / 1024),
        },
        historianDumps: collectHistorianDumps(),
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function renderDiagnosticsMarkdown(report: DiagnosticReport): string {
    const configPaths = {
        configDir: sanitizeString(report.configPaths.configDir),
        opencodeConfig: sanitizeString(report.configPaths.opencodeConfig),
        opencodeConfigFormat: report.configPaths.opencodeConfigFormat,
        magicContextConfig: sanitizeString(report.configPaths.magicContextConfig),
        tuiConfig: sanitizeString(report.configPaths.tuiConfig),
        tuiConfigFormat: report.configPaths.tuiConfigFormat,
        omoConfig: report.configPaths.omoConfig
            ? sanitizeString(report.configPaths.omoConfig)
            : null,
    };

    const pluginCache = {
        path: sanitizeString(report.pluginCache.path),
        cached: report.pluginCache.cached ?? null,
        latest: report.pluginCache.latest ?? null,
    };

    const storage = {
        path: sanitizeString(report.storageDir.path),
        exists: report.storageDir.exists,
        context_db_size: formatBytes(report.storageDir.contextDbSizeBytes),
    };

    const historianDumps = {
        dir: sanitizeString(report.historianDumps.dir),
        count: report.historianDumps.count,
        recent: report.historianDumps.recent,
    };

    return [
        `- Timestamp: ${report.timestamp}`,
        `- Plugin: v${report.pluginVersion}`,
        `- OS: ${report.platform} ${report.arch}`,
        `- Node: ${report.nodeVersion}`,
        `- OpenCode installed: ${report.opencodeInstalled}${report.opencodeVersion ? ` (${report.opencodeVersion})` : ""}`,
        `- Plugin registered in opencode config: ${report.opencodeConfigHasPlugin}`,
        `- Plugin registered in tui config: ${report.tuiConfigHasPlugin}`,
        `- magic-context.jsonc parse error: ${report.magicContextConfig.parseError ?? "none"}`,
        `- Conflicts detected: ${report.conflicts.hasConflict ? report.conflicts.reasons.join("; ") : "none"}`,
        "",
        "### Config paths",
        "```json",
        JSON.stringify(configPaths, null, 2),
        "```",
        "",
        "### magic-context.jsonc flags",
        "```jsonc",
        JSON.stringify(report.magicContextConfig.flags, null, 2),
        "```",
        "",
        "### Plugin cache",
        "```json",
        JSON.stringify(pluginCache, null, 2),
        "```",
        "",
        "### Storage",
        "```json",
        JSON.stringify(storage, null, 2),
        "```",
        "",
        "### Historian dumps",
        "```json",
        JSON.stringify(historianDumps, null, 2),
        "```",
        "",
        "### Log file",
        `- Path: ${sanitizeString(report.logFile.path)}`,
        `- Exists: ${report.logFile.exists}`,
        `- Size: ${report.logFile.sizeKb} KB`,
    ].join("\n");
}
