/**
 * Read git commit history from a working directory using `git log`.
 *
 * Wraps a single `git log` invocation with controlled flags and parses the
 * null-delimited output. Runs synchronously with a timeout guard — indexing
 * happens on a plugin timer, not on the hot transform path, so blocking for
 * a few hundred milliseconds once per refresh is acceptable.
 *
 * Parsing contract:
 *   - We request `--format=%H%x00%s%x00%ae%x00%ct%x00%b%x1e`:
 *       %H = full 40-char SHA
 *       %s = subject (one line)
 *       %ae = author email
 *       %ct = committer time (seconds since epoch)
 *       %b = body (multi-line)
 *     Fields are separated by NUL (\0), records by RS (0x1e).
 *   - Subject + trimmed body combine into the searchable message.
 *   - We skip merge commits via `--no-merges` so merge "Merge branch 'x'"
 *     noise doesn't fill the index.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
/** Hard cap on commits returned per invocation. Indexer loops with since-filter
 *  if it needs more history. */
const DEFAULT_MAX_COMMITS = 5000;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x00";

export interface GitCommit {
    /** Full 40-char SHA. */
    sha: string;
    /** First 7 chars of SHA for display. */
    shortSha: string;
    /** Subject + body, joined with a blank line when body exists. */
    message: string;
    /** Author email, or null when unavailable. */
    author: string | null;
    /** Committer time in milliseconds since epoch. */
    committedAtMs: number;
}

export interface ReadGitCommitsOptions {
    /** Only include commits newer than this (milliseconds since epoch). */
    sinceMs?: number;
    /** Only include commits reachable from HEAD (the default). */
    branch?: string;
    /** Hard cap on returned commits. Default 5000. */
    maxCommits?: number;
}

/**
 * Read commits reachable from HEAD (or `branch` when provided) up to
 * `maxCommits`, optionally filtered by `sinceMs`. Returns an empty array
 * when git is unavailable or the directory is not a repo. Does NOT throw
 * on non-zero git exit — logs and returns empty so indexing failures
 * never crash the plugin.
 */
export async function readGitCommits(
    directory: string,
    options: ReadGitCommitsOptions = {},
): Promise<GitCommit[]> {
    const args = [
        "log",
        options.branch ?? "HEAD",
        "--no-merges",
        `--max-count=${options.maxCommits ?? DEFAULT_MAX_COMMITS}`,
        `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
    ];
    if (options.sinceMs !== undefined && options.sinceMs > 0) {
        // git accepts ISO 8601 to --since
        const iso = new Date(options.sinceMs).toISOString();
        args.push(`--since=${iso}`);
    }

    let stdout: string;
    try {
        const result = await execFileAsync("git", args, {
            cwd: directory,
            timeout: GIT_TIMEOUT_MS,
            // Default buffer is 1MB; bump to 32MB for large repos. Commits are
            // small but history can be long.
            maxBuffer: 32 * 1024 * 1024,
            encoding: "utf8",
        });
        stdout = result.stdout;
    } catch {
        // Intentional: git may not be installed, directory may not be a repo,
        // or the invocation may time out. All are "skip indexing this cycle"
        // conditions, not crashes. We return empty and the next sweep will
        // retry.
        return [];
    }

    return parseGitLogOutput(stdout);
}

export function parseGitLogOutput(stdout: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const records = stdout.split(RECORD_SEPARATOR);

    for (const rawRecord of records) {
        const record = rawRecord.replace(/^\s+/, "");
        if (!record) continue;

        const fields = record.split(FIELD_SEPARATOR);
        if (fields.length < 5) continue;

        const sha = fields[0].trim();
        const subject = fields[1].trim();
        const author = fields[2].trim();
        const timeSec = Number.parseInt(fields[3].trim(), 10);
        const body = fields[4].trim();

        if (sha.length !== 40 || !Number.isFinite(timeSec) || timeSec <= 0) {
            continue;
        }

        const message = body.length > 0 ? `${subject}\n\n${body}` : subject;

        commits.push({
            sha,
            shortSha: sha.slice(0, 7),
            message,
            author: author.length > 0 ? author : null,
            committedAtMs: timeSec * 1000,
        });
    }

    return commits;
}
