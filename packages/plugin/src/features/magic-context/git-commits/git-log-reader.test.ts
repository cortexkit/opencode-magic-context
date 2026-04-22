import { describe, expect, it } from "bun:test";
import { parseGitLogOutput, readGitCommits } from "./git-log-reader";

describe("parseGitLogOutput", () => {
    it("parses a single commit record", () => {
        const sha = "a".repeat(40);
        const out = `${sha}\x00fix: wire bun runtime\x00me@example.com\x001700000000\x00\x1e`;

        const commits = parseGitLogOutput(out);
        expect(commits).toHaveLength(1);
        expect(commits[0]).toMatchObject({
            sha,
            shortSha: sha.slice(0, 7),
            message: "fix: wire bun runtime",
            author: "me@example.com",
            committedAtMs: 1700000000_000,
        });
    });

    it("joins subject and body with blank line when body present", () => {
        const sha = "b".repeat(40);
        const out = `${sha}\x00subject\x00me\x001700000001\x00body line 1\nbody line 2\x1e`;

        const commits = parseGitLogOutput(out);
        expect(commits).toHaveLength(1);
        expect(commits[0].message).toBe("subject\n\nbody line 1\nbody line 2");
    });

    it("skips records with invalid SHA length", () => {
        const out = `short\x00subject\x00me\x001700000000\x00\x1e`;
        expect(parseGitLogOutput(out)).toHaveLength(0);
    });

    it("skips records with non-finite or zero timestamps", () => {
        const sha = "c".repeat(40);
        const bad = `${sha}\x00subject\x00me\x00NaN\x00\x1e`;
        const zero = `${sha}\x00subject\x00me\x000\x00\x1e`;
        expect(parseGitLogOutput(bad)).toHaveLength(0);
        expect(parseGitLogOutput(zero)).toHaveLength(0);
    });

    it("handles multiple records", () => {
        const s1 = "a".repeat(40);
        const s2 = "b".repeat(40);
        const s3 = "c".repeat(40);
        const out =
            `${s1}\x00first\x00a@a\x001700000000\x00\x1e` +
            `${s2}\x00second\x00b@b\x001700000100\x00body\x1e` +
            `${s3}\x00third\x00\x001700000200\x00\x1e`;

        const commits = parseGitLogOutput(out);
        expect(commits).toHaveLength(3);
        expect(commits[0].sha).toBe(s1);
        expect(commits[1].message).toBe("second\n\nbody");
        // Empty author becomes null.
        expect(commits[2].author).toBeNull();
    });

    it("ignores empty trailing record after separator", () => {
        const sha = "d".repeat(40);
        const out = `${sha}\x00s\x00a\x001700000000\x00\x1e\n`;
        expect(parseGitLogOutput(out)).toHaveLength(1);
    });
});

describe("readGitCommits (smoke)", () => {
    it("returns empty array for a non-git directory without throwing", async () => {
        const commits = await readGitCommits("/tmp", { maxCommits: 5 });
        expect(Array.isArray(commits)).toBe(true);
    });
});
