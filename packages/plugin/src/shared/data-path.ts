import * as os from "node:os";
import * as path from "node:path";

export function getDataDir(): string {
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

export function getOpenCodeStorageDir(): string {
    return path.join(getDataDir(), "opencode", "storage");
}

/**
 * Resolve OpenCode's cache base directory.
 *
 * OpenCode uses the `xdg-basedir` package, which — on every platform, including
 * Windows — falls back to `<homedir>/.cache` when `XDG_CACHE_HOME` is unset.
 * A previous Windows-specific branch that resolved to `%LOCALAPPDATA%` did not
 * match OpenCode's own resolution and caused `doctor --force` to target a
 * non-existent directory, leaving the real cache at `C:\Users\<user>\.cache`
 * untouched.
 */
export function getCacheDir(): string {
    return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

export function getOpenCodeCacheDir(): string {
    return path.join(getCacheDir(), "opencode");
}
