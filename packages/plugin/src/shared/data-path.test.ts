import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getCacheDir, getDataDir, getOpenCodeCacheDir, getOpenCodeStorageDir } from "./data-path";

const savedEnv = {
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
};

describe("data-path", () => {
    beforeEach(() => {
        process.env.XDG_CACHE_HOME = undefined;
        process.env.XDG_DATA_HOME = undefined;
        process.env.LOCALAPPDATA = undefined;
        // Bun's env handling: explicit delete for unset
        delete process.env.XDG_CACHE_HOME;
        delete process.env.XDG_DATA_HOME;
        delete process.env.LOCALAPPDATA;
    });

    afterEach(() => {
        if (savedEnv.XDG_CACHE_HOME !== undefined)
            process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
        if (savedEnv.XDG_DATA_HOME !== undefined)
            process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
        if (savedEnv.LOCALAPPDATA !== undefined) process.env.LOCALAPPDATA = savedEnv.LOCALAPPDATA;
    });

    test("getCacheDir falls back to <homedir>/.cache when XDG_CACHE_HOME is unset (all platforms)", () => {
        // Matches OpenCode's xdg-basedir behavior on every platform, including
        // Windows. A previous bug mapped Windows to %LOCALAPPDATA% and caused
        // doctor --force to target a non-existent cache directory.
        expect(getCacheDir()).toBe(path.join(os.homedir(), ".cache"));
    });

    test("getCacheDir honors XDG_CACHE_HOME when set", () => {
        process.env.XDG_CACHE_HOME = "/tmp/custom-cache";
        expect(getCacheDir()).toBe("/tmp/custom-cache");
    });

    test("getCacheDir ignores LOCALAPPDATA on Windows (must match OpenCode's xdg-basedir)", () => {
        // Even with LOCALAPPDATA set, cache must go to ~/.cache to match
        // OpenCode's own resolution. Otherwise doctor --force clears the
        // wrong directory on Windows.
        process.env.LOCALAPPDATA = "C:\\Users\\Test\\AppData\\Local";
        expect(getCacheDir()).toBe(path.join(os.homedir(), ".cache"));
    });

    test("getOpenCodeCacheDir appends 'opencode' to the cache base", () => {
        expect(getOpenCodeCacheDir()).toBe(path.join(os.homedir(), ".cache", "opencode"));
    });

    test("getOpenCodeCacheDir with XDG_CACHE_HOME set", () => {
        process.env.XDG_CACHE_HOME = "/tmp/custom-cache";
        expect(getOpenCodeCacheDir()).toBe(path.join("/tmp/custom-cache", "opencode"));
    });

    test("getDataDir falls back to <homedir>/.local/share when XDG_DATA_HOME is unset", () => {
        expect(getDataDir()).toBe(path.join(os.homedir(), ".local", "share"));
    });

    test("getOpenCodeStorageDir composes correctly", () => {
        expect(getOpenCodeStorageDir()).toBe(
            path.join(os.homedir(), ".local", "share", "opencode", "storage"),
        );
    });
});
