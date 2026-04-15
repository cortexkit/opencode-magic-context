import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "comment-json";
import { detectConflicts } from "../shared/conflict-detector";
import { fixConflicts } from "../shared/conflict-fixer";
import { ensureTuiPluginEntry } from "../shared/tui-config";
import { detectConfigPaths } from "./config-paths";
import { collectDiagnostics } from "./diagnostics";
import { bundleIssueReport } from "./logs";
import { isOpenCodeInstalled } from "./opencode-helpers";
import { confirm, intro, log, outro, spinner, text } from "./prompts";

const PLUGIN_NAME = "@cortexkit/opencode-magic-context";
const PLUGIN_ENTRY_WITH_VERSION = `${PLUGIN_NAME}@latest`;

/**
 * Resolve OpenCode's XDG-based cache directory.
 * OpenCode uses `xdg-basedir` which resolves to:
 * - macOS/Linux: $XDG_CACHE_HOME or ~/.cache
 * - Windows: $XDG_CACHE_HOME or %LOCALAPPDATA%
 * Plugin cache lives at <cacheDir>/opencode/packages/<pkg>/
 */
function getOpenCodeCacheDir(): string {
    const xdgCache = process.env.XDG_CACHE_HOME;
    if (xdgCache) return join(xdgCache, "opencode");

    const os = platform();
    if (os === "win32") {
        const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
        return join(localAppData, "opencode");
    }
    // macOS + Linux
    return join(homedir(), ".cache", "opencode");
}

async function clearPluginCache(force = false): Promise<{
    action: "cleared" | "up_to_date" | "not_found" | "error";
    path: string;
    cached?: string;
    latest?: string;
    error?: string;
}> {
    const cacheDir = getOpenCodeCacheDir();
    const pluginCacheDir = join(cacheDir, "packages", PLUGIN_ENTRY_WITH_VERSION);

    if (!existsSync(pluginCacheDir)) {
        return { action: "not_found", path: pluginCacheDir };
    }

    // Read cached version from the installed package.json (more reliable than package-lock.json)
    let cachedVersion: string | undefined;
    try {
        const installedPkgPath = join(
            pluginCacheDir,
            "node_modules",
            "@cortexkit",
            "opencode-magic-context",
            "package.json",
        );
        if (existsSync(installedPkgPath)) {
            const pkg = JSON.parse(readFileSync(installedPkgPath, "utf-8"));
            if (typeof pkg?.version === "string") {
                cachedVersion = pkg.version;
            }
        }
    } catch {
        // Can't read cached version — proceed with clearing
    }

    // Compare against our own version — when running via `bunx --bun @cortexkit/opencode-magic-context@latest doctor`,
    // our package.json IS the latest published version. No network call needed.
    // Try multiple relative paths to handle both src/ and dist/ build output locations.
    const require = createRequire(import.meta.url);
    let selfVersion: string | undefined;
    for (const relPath of ["../../package.json", "../package.json"]) {
        try {
            selfVersion = (require(relPath) as { version?: string }).version;
            if (selfVersion) break;
        } catch {
            // Try next path
        }
    }

    // If we know both versions and they match, skip (unless forced)
    if (!force && cachedVersion && cachedVersion === selfVersion) {
        return {
            action: "up_to_date",
            path: pluginCacheDir,
            cached: cachedVersion,
            latest: selfVersion,
        };
    }

    try {
        rmSync(pluginCacheDir, { recursive: true, force: true });
        return {
            action: "cleared",
            path: pluginCacheDir,
            cached: cachedVersion,
            latest: selfVersion,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { action: "error", path: pluginCacheDir, error: msg };
    }
}

// ── Issue flow ──────────────────────────────────────────────────────

function isGhInstalled(): boolean {
    try {
        execSync("gh --version", { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function openBrowser(url: string): void {
    try {
        if (process.platform === "darwin") {
            const child = spawnSync("open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "linux") {
            const child = spawnSync("xdg-open", [url], { stdio: "ignore" });
            if (child.status === 0) return;
        } else if (process.platform === "win32") {
            const child = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
            if (child.status === 0) return;
        }
    } catch {
        // Best-effort only.
    }
}

async function runIssueFlow(): Promise<number> {
    intro("Magic Context Issue Report");

    const title = await text("Issue title", {
        placeholder: "Short summary of the problem",
        validate: (value) => (value.trim() ? undefined : "Title is required"),
    });
    const description = await text("Issue description", {
        placeholder: "Describe what happened, what you expected, and repro steps",
        validate: (value) => (value.trim() ? undefined : "Description is required"),
    });

    const s = spinner();
    s.start("Collecting diagnostics");

    try {
        const report = await collectDiagnostics();
        const bundled = await bundleIssueReport(report, description, title);
        s.stop(`Report written to ${bundled.path}`);

        const shouldSubmit = await confirm("Submit this issue on GitHub now?", true);
        if (shouldSubmit && isGhInstalled()) {
            const result = spawnSync(
                "gh",
                [
                    "issue",
                    "create",
                    "-R",
                    "cortexkit/opencode-magic-context",
                    "--title",
                    title,
                    "--body-file",
                    bundled.path,
                ],
                { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
            );

            if (result.status === 0) {
                log.success(result.stdout.trim());
                outro("Issue submitted — thanks for the report!");
                return 0;
            }

            log.warn(result.stderr.trim() || "gh issue create failed");
        } else if (shouldSubmit && !isGhInstalled()) {
            log.warn("gh CLI not found — falling back to browser");
        }

        const url = `https://github.com/cortexkit/opencode-magic-context/issues/new?title=${encodeURIComponent(title)}&template=bug_report.yml`;
        log.info(
            `Open this URL and paste the contents of ${bundled.path} into the Diagnostics field:`,
        );
        log.info(url);
        openBrowser(url);
        outro("Issue report ready");
        return 0;
    } catch (error) {
        s.stop("Diagnostic collection failed");
        log.error(error instanceof Error ? error.message : String(error));
        outro("Issue report failed");
        return 1;
    }
}

// ── Main doctor entry ───────────────────────────────────────────────

export async function runDoctor(
    options: { force?: boolean; issue?: boolean } = {},
): Promise<number> {
    if (options.issue) {
        return runIssueFlow();
    }

    intro("Magic Context Doctor");

    let issues = 0;
    let fixed = 0;

    // 1. Check OpenCode is installed
    if (!isOpenCodeInstalled()) {
        log.error("OpenCode is not installed or not in PATH");
        outro("Doctor failed — install OpenCode first");
        return 1;
    }
    log.success("OpenCode installed");

    // 2. Check config paths exist
    const paths = detectConfigPaths();

    if (paths.opencodeConfigFormat === "none") {
        log.error(`No opencode.json found at ${paths.opencodeConfig}`);
        issues++;
    } else {
        log.success(`OpenCode config: ${paths.opencodeConfig}`);
    }

    // 3. Check magic-context.jsonc exists
    if (existsSync(paths.magicContextConfig)) {
        log.success(`Magic Context config: ${paths.magicContextConfig}`);
    } else {
        log.warn(`No magic-context.jsonc found — using defaults`);
        log.info("  Run 'setup' to create one with model recommendations");
    }

    // 3b. Migrate deprecated experimental config keys in magic-context.jsonc
    if (existsSync(paths.magicContextConfig)) {
        try {
            const mcRaw = readFileSync(paths.magicContextConfig, "utf-8");
            const mcConfig = parse(mcRaw) as Record<string, unknown>;
            let mcChanged = false;

            // Migrate experimental.compaction_markers → top-level compaction_markers
            const experimental = mcConfig.experimental as Record<string, unknown> | undefined;
            if (experimental && "compaction_markers" in experimental) {
                if (!("compaction_markers" in mcConfig)) {
                    // Promote value to top level only if not already set
                    mcConfig.compaction_markers = experimental.compaction_markers;
                }
                delete experimental.compaction_markers;
                mcChanged = true;
                // Clean up empty experimental object
                if (Object.keys(experimental).length === 0) {
                    delete mcConfig.experimental;
                }
                log.success(
                    "Migrated experimental.compaction_markers → compaction_markers (now default: true)",
                );
                fixed++;
            }

            if (mcChanged) {
                writeFileSync(paths.magicContextConfig, `${stringify(mcConfig, null, 2)}\n`);
            }
        } catch {
            log.warn("Could not migrate deprecated config keys in magic-context.jsonc");
        }
    }

    // 4. Check plugin is in opencode.json
    if (paths.opencodeConfigFormat !== "none") {
        try {
            const raw = readFileSync(paths.opencodeConfig, "utf-8");
            const config = parse(raw) as Record<string, unknown>;
            const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
            const pluginList = (plugins as unknown[]).filter(
                (p): p is string => typeof p === "string",
            );
            const existingIdx = pluginList.findIndex(
                (p) =>
                    p === PLUGIN_NAME ||
                    p.startsWith(`${PLUGIN_NAME}@`) ||
                    p.includes("opencode-magic-context"),
            );
            const configName =
                paths.opencodeConfigFormat === "jsonc" ? "opencode.jsonc" : "opencode.json";
            if (existingIdx >= 0 && pluginList[existingIdx] === PLUGIN_ENTRY_WITH_VERSION) {
                log.success(`Plugin registered in ${configName}`);
            } else if (existingIdx >= 0) {
                const oldEntry = pluginList[existingIdx];
                const isPinned =
                    oldEntry !== PLUGIN_NAME &&
                    oldEntry !== PLUGIN_ENTRY_WITH_VERSION &&
                    /^@cortexkit\/opencode-magic-context@\d/.test(oldEntry);

                if (isPinned && !options.force) {
                    // Warn but don't change — user intentionally pinned
                    log.warn(
                        `Plugin pinned to ${oldEntry} in ${configName} — use 'doctor --force' to upgrade`,
                    );
                } else {
                    // Upgrade versionless entry to @latest, or --force upgrades pinned
                    pluginList[existingIdx] = PLUGIN_ENTRY_WITH_VERSION;
                    config.plugin = pluginList;
                    writeFileSync(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                    log.success(
                        `Upgraded plugin entry in ${configName}: ${oldEntry} → ${PLUGIN_ENTRY_WITH_VERSION}`,
                    );
                    fixed++;
                }
            } else {
                // Auto-add plugin entry — preserves comments
                pluginList.push(PLUGIN_ENTRY_WITH_VERSION);
                config.plugin = pluginList;
                writeFileSync(paths.opencodeConfig, `${stringify(config, null, 2)}\n`);
                log.success(`Added plugin to ${configName}`);
                fixed++;
            }
        } catch {
            log.warn("Could not parse opencode config to verify plugin entry");
        }
    }

    // 5. Check for conflicts
    const cwd = process.cwd();
    const conflictResult = detectConflicts(cwd);

    if (conflictResult.hasConflict) {
        for (const reason of conflictResult.reasons) {
            log.error(`Conflict: ${reason}`);
        }
        // Auto-fix conflicts
        const actions = fixConflicts(cwd, conflictResult.conflicts);
        for (const action of actions) {
            log.success(`Fixed: ${action}`);
            fixed++;
        }
        // Only count unfixed conflicts as issues
        issues += conflictResult.reasons.length - actions.length;

        if (actions.length > 0) {
            log.warn("Restart OpenCode for conflict fixes to take effect");
        }
    } else {
        log.success("No conflicts detected (compaction, DCP, OMO hooks)");
    }

    // 6. Check tui.json
    const tuiAdded = ensureTuiPluginEntry();
    if (tuiAdded) {
        log.success("Added TUI sidebar plugin to tui.json");
        log.warn("Restart OpenCode to see the sidebar");
        fixed++;
    } else if (existsSync(paths.tuiConfig)) {
        // Check for pinned version in tui config
        try {
            const tuiRaw = readFileSync(paths.tuiConfig, "utf-8");
            const tuiConfig = parse(tuiRaw) as Record<string, unknown>;
            const tuiPlugins = Array.isArray(tuiConfig?.plugin)
                ? (tuiConfig.plugin as unknown[]).filter((p): p is string => typeof p === "string")
                : [];
            const tuiIdx = tuiPlugins.findIndex(
                (p) => p === PLUGIN_NAME || p.startsWith(`${PLUGIN_NAME}@`),
            );
            if (tuiIdx >= 0) {
                const tuiEntry = tuiPlugins[tuiIdx];
                const tuiPinned =
                    tuiEntry !== PLUGIN_NAME &&
                    tuiEntry !== PLUGIN_ENTRY_WITH_VERSION &&
                    /^@cortexkit\/opencode-magic-context@\d/.test(tuiEntry);
                if (tuiPinned && !options.force) {
                    log.warn(
                        `TUI plugin pinned to ${tuiEntry} — use 'doctor --force' to upgrade`,
                    );
                } else if (tuiPinned && options.force) {
                    tuiPlugins[tuiIdx] = PLUGIN_ENTRY_WITH_VERSION;
                    tuiConfig.plugin = tuiPlugins;
                    writeFileSync(paths.tuiConfig, `${stringify(tuiConfig, null, 2)}\n`);
                    log.success(
                        `Upgraded TUI plugin: ${tuiEntry} → ${PLUGIN_ENTRY_WITH_VERSION}`,
                    );
                    fixed++;
                } else {
                    log.success("TUI sidebar plugin configured");
                }
            } else {
                log.success("TUI sidebar plugin configured");
            }
        } catch {
            log.success("TUI sidebar plugin configured");
        }
    } else {
        log.success("TUI sidebar plugin configured (tui.json created)");
    }

    // 7. Check user memories + dreamer compatibility
    if (existsSync(paths.magicContextConfig)) {
        try {
            const mcRaw = readFileSync(paths.magicContextConfig, "utf-8");
            const mcConfig = parse(mcRaw) as Record<string, unknown>;
            const userMemObj = (mcConfig?.experimental as Record<string, unknown>)?.user_memories as
                | Record<string, unknown>
                | undefined;
            const userMemEnabled = userMemObj?.enabled === true;
            const dreamerObj = mcConfig?.dreamer as Record<string, unknown> | undefined;
            const dreamerEnabled = dreamerObj?.enabled === true;
            if (userMemEnabled && !dreamerEnabled) {
                log.warn(
                    "experimental_user_memories is enabled but dreamer is disabled — user memory candidates will be collected but never promoted to stable memories",
                );
                issues++;
            }
        } catch {
            // Config parse failed — skip this check
        }
    }

    // 8. Check plugin npm cache — clear only if outdated
    const cacheResult = await clearPluginCache(options.force);
    if (cacheResult.action === "cleared") {
        const versionInfo = cacheResult.cached
            ? ` (cached: ${cacheResult.cached}${cacheResult.latest ? `, latest: ${cacheResult.latest}` : ""})`
            : "";
        log.success(
            `Cleared outdated plugin cache${versionInfo} — latest will download on restart`,
        );
        log.info(`  ${cacheResult.path}`);
        fixed++;
    } else if (cacheResult.action === "up_to_date") {
        log.success(`Plugin cache up to date (v${cacheResult.cached})`);
    } else if (cacheResult.action === "error") {
        log.warn(`Could not clear plugin cache: ${cacheResult.error}`);
        log.info(`  Manually delete: ${cacheResult.path}`);
        issues++;
    } else {
        log.success("Plugin cache clean (no cached version found)");
    }

    // 9. Check for min-release-age / minimumReleaseAge restrictions
    // OpenCode uses @npmcli/arborist (npm core) to install plugins, so .npmrc
    // restrictions apply. Bun's bunfig.toml is checked too for users who install
    // via bunx manually.
    {
        const ageWarnings: string[] = [];

        // Check ~/.npmrc for min-release-age or before
        const npmrcPath = join(homedir(), ".npmrc");
        if (existsSync(npmrcPath)) {
            try {
                const npmrc = readFileSync(npmrcPath, "utf-8");
                for (const line of npmrc.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
                    const [key] = trimmed.split("=").map((s) => s.trim());
                    if (key === "min-release-age" || key === "before") {
                        ageWarnings.push(`~/.npmrc has '${trimmed}'`);
                    }
                }
            } catch {
                // Can't read .npmrc — skip
            }
        }

        // Check ~/.bunfig.toml for minimumReleaseAge
        const bunfigPath = join(homedir(), ".bunfig.toml");
        if (existsSync(bunfigPath)) {
            try {
                const bunfig = readFileSync(bunfigPath, "utf-8");
                for (const line of bunfig.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("#")) continue;
                    if (/minimumReleaseAge\s*=/.test(trimmed)) {
                        ageWarnings.push(`~/.bunfig.toml has '${trimmed}'`);
                    }
                }
            } catch {
                // Can't read bunfig — skip
            }
        }

        if (ageWarnings.length > 0) {
            log.warn(
                "Package manager min-release-age restriction detected — this can prevent OpenCode from installing the latest plugin version",
            );
            for (const w of ageWarnings) {
                log.info(`  ${w}`);
            }
            log.info(
                "  If the plugin stays on an old version after doctor --force, this is the likely cause.",
            );
            log.info(
                "  Workaround: temporarily remove the restriction, restart OpenCode, then re-enable it.",
            );
            issues++;
        }
    }

    // 10. Show diagnostics info (log file, historian dumps)

    const logPath = join(tmpdir(), "magic-context.log");
    if (existsSync(logPath)) {
        const logStat = statSync(logPath);
        const sizeKb = (logStat.size / 1024).toFixed(0);
        log.info(`Log file: ${logPath} (${sizeKb} KB)`);
    } else {
        log.info(`Log file: ${logPath} (not yet created)`);
    }

    const historianDumpDir = join(tmpdir(), "magic-context-historian");
    if (existsSync(historianDumpDir)) {
        try {
            const dumps = readdirSync(historianDumpDir)
                .filter((f) => f.endsWith(".xml"))
                .map((f) => ({
                    name: f,
                    mtime: statSync(join(historianDumpDir, f)).mtimeMs,
                }))
                .sort((a, b) => b.mtime - a.mtime);
            if (dumps.length > 0) {
                log.warn(`Historian debug dumps: ${dumps.length} file(s) in ${historianDumpDir}`);
                for (const dump of dumps.slice(0, 3)) {
                    const age = Math.round((Date.now() - dump.mtime) / 60000);
                    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                    log.info(`  ${dump.name} (${ageStr})`);
                }
                if (dumps.length > 3) {
                    log.info(`  ... and ${dumps.length - 3} more`);
                }
            }
        } catch {
            // Can't read dump directory — skip
        }
    }

    // 11. Check OMO config
    if (paths.omoConfig) {
        log.info(`OMO config found: ${paths.omoConfig}`);
    }

    // Summary
    console.log("");
    if (issues === 0 && fixed === 0) {
        outro("Everything looks good! ✨");
    } else if (issues > 0 && fixed > 0) {
        outro(`Found ${issues} issue(s), fixed ${fixed}. Restart OpenCode to apply.`);
    } else if (fixed > 0) {
        outro(`Fixed ${fixed} issue(s). Restart OpenCode to apply.`);
    } else {
        outro(`Found ${issues} issue(s) that need manual attention.`);
        return 1;
    }

    return 0;
}
