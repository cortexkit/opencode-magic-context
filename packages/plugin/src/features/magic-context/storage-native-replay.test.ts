/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    addNativeReasoningIds,
    getNativeReasoningIds,
    getNativeToolInputs,
    saveNativeToolInputs,
} from "./storage-native-replay";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("native replay storage", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        db.close();
    });

    it("treats absent and null native state as empty", () => {
        expect(getNativeToolInputs(db, "missing")).toEqual(new Map());
        expect(getNativeReasoningIds(db, "missing")).toEqual(new Set());

        const legacy = new Database(":memory:");
        try {
            legacy.exec(`
                CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    pi_native_tool_inputs TEXT,
                    pi_native_reasoning_ids TEXT
                );
            `);
            legacy
                .prepare(
                    "INSERT INTO session_meta (session_id, pi_native_tool_inputs, pi_native_reasoning_ids) VALUES (?, NULL, NULL)",
                )
                .run("legacy");

            expect(getNativeToolInputs(legacy, "legacy")).toEqual(new Map());
            expect(getNativeReasoningIds(legacy, "legacy")).toEqual(new Set());
        } finally {
            legacy.close();
        }
    });

    it("keeps legacy replay watermarks from seeding either native lane across an upgrade", () => {
        db.prepare(
            `INSERT INTO session_meta
                (session_id, cleared_reasoning_through_tag, tool_reclaim_watermark,
                 stale_reduce_stripped_ids)
             VALUES (?, ?, ?, ?)`,
        ).run("legacy", 42, 24, JSON.stringify(["legacy-message"]));
        db.exec("ALTER TABLE session_meta DROP COLUMN pi_native_tool_inputs");
        db.exec("ALTER TABLE session_meta DROP COLUMN pi_native_reasoning_ids");

        initializeDatabase(db);

        expect(getNativeToolInputs(db, "legacy")).toEqual(new Map());
        expect(getNativeReasoningIds(db, "legacy")).toEqual(new Set());
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("fresh");
        expect(getNativeToolInputs(db, "fresh")).toEqual(new Map());
        expect(getNativeReasoningIds(db, "fresh")).toEqual(new Set());
    });

    it("persists only explicit native decisions and keeps the lanes independent", () => {
        const initialInput = '{"path":"src/old.ts","marker":"[truncated]"}';
        const refreshedInput = '{"path":"src/old.ts","marker":"[full]"}';
        const secondInput = '{"path":"src/new.ts"}';

        saveNativeToolInputs(db, "session", new Map([["call-1", initialInput]]));

        expect(getNativeToolInputs(db, "session")).toEqual(new Map([["call-1", initialInput]]));
        expect(getNativeReasoningIds(db, "session")).toEqual(new Set());

        addNativeReasoningIds(db, "session", ["assistant-1", "assistant-2"]);
        saveNativeToolInputs(
            db,
            "session",
            new Map([
                ["call-1", refreshedInput],
                ["call-2", secondInput],
            ]),
        );

        expect(getNativeToolInputs(db, "session")).toEqual(
            new Map([
                ["call-1", refreshedInput],
                ["call-2", secondInput],
            ]),
        );
        expect(getNativeReasoningIds(db, "session")).toEqual(
            new Set(["assistant-1", "assistant-2"]),
        );
    });

    it("replays exact tool bytes and reasoning ids after reopening the database", () => {
        const directory = mkdtempSync(join(tmpdir(), "magic-context-native-replay-"));
        const path = join(directory, "context.db");
        const input = '{"path":"src/reopened.ts","range":{"start":1,"end":9}}';
        try {
            const writer = new Database(path);
            try {
                initializeDatabase(writer);
                runMigrations(writer);
                saveNativeToolInputs(writer, "session", new Map([["call-1", input]]));
                addNativeReasoningIds(writer, "session", ["assistant-1"]);
            } finally {
                writer.close();
            }

            const reader = new Database(path);
            try {
                expect(getNativeToolInputs(reader, "session")).toEqual(
                    new Map([["call-1", input]]),
                );
                expect(getNativeReasoningIds(reader, "session")).toEqual(new Set(["assistant-1"]));
            } finally {
                reader.close();
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("fails closed on malformed durable native state", () => {
        db.prepare(
            "INSERT INTO session_meta (session_id, pi_native_tool_inputs) VALUES (?, ?)",
        ).run("bad-tool", '{"call-1":"not-json"}');
        db.prepare(
            "INSERT INTO session_meta (session_id, pi_native_reasoning_ids) VALUES (?, ?)",
        ).run("bad-reasoning", "not-json");

        expect(() => getNativeToolInputs(db, "bad-tool")).toThrow(
            "invalid persisted pi_native_tool_inputs state",
        );
        expect(() => getNativeReasoningIds(db, "bad-reasoning")).toThrow(
            "invalid persisted pi_native_reasoning_ids state",
        );
    });

    it("rolls back a failed write without changing either durable lane", () => {
        const firstInput = '{"path":"src/first.ts"}';
        saveNativeToolInputs(db, "session", new Map([["call-1", firstInput]]));
        addNativeReasoningIds(db, "session", ["assistant-1"]);
        db.exec(`
            CREATE TRIGGER fail_native_tool_input_update
            BEFORE UPDATE OF pi_native_tool_inputs ON session_meta
            WHEN NEW.session_id = 'session'
            BEGIN
                SELECT RAISE(ABORT, 'injected native tool write failure');
            END;
            CREATE TRIGGER fail_native_reasoning_update
            BEFORE UPDATE OF pi_native_reasoning_ids ON session_meta
            WHEN NEW.session_id = 'session'
            BEGIN
                SELECT RAISE(ABORT, 'injected native reasoning write failure');
            END;
        `);

        expect(() =>
            saveNativeToolInputs(db, "session", new Map([["call-2", '{"path":"src/second.ts"}']])),
        ).toThrow("injected native tool write failure");
        expect(() => addNativeReasoningIds(db, "session", ["assistant-2"])).toThrow(
            "injected native reasoning write failure",
        );

        expect(getNativeToolInputs(db, "session")).toEqual(new Map([["call-1", firstInput]]));
        expect(getNativeReasoningIds(db, "session")).toEqual(new Set(["assistant-1"]));
    });
});
