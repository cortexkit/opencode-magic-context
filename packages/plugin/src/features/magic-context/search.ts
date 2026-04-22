import type { Database } from "bun:sqlite";
import { readRawSessionMessages } from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { log } from "../../shared/logger";
import { type GitCommitSearchHit, searchGitCommitsSync } from "./git-commits";
import {
    ensureMemoryEmbeddings,
    getMemoriesByProject,
    getProjectEmbeddings,
    type Memory,
    peekProjectEmbeddings,
    searchMemoriesFTS,
    updateMemoryRetrievalCount,
} from "./memory";
import { cosineSimilarity } from "./memory/cosine-similarity";
import { embedText, isEmbeddingEnabled } from "./memory/embedding";
import { sanitizeFtsQuery } from "./memory/storage-memory-fts";
import { ensureMessagesIndexed } from "./message-index";
import { getSessionFacts, type SessionFact } from "./storage";

type PreparedStatement = ReturnType<Database["prepare"]>;

const DEFAULT_UNIFIED_SEARCH_LIMIT = 10;
const FTS_SEMANTIC_CANDIDATE_LIMIT = 50;
const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;
const RESULT_PREVIEW_LIMIT = 220;
/** Source boost multipliers for unified ranking — higher-signal sources get a mild score boost. */
const MEMORY_SOURCE_BOOST = 1.3;
const FACT_SOURCE_BOOST = 1.15;
const MESSAGE_SOURCE_BOOST = 1.0;
/** Git commits boost — slightly below memories because commit messages are
 *  terser by nature. Ranks above raw history but below curated memory. */
const GIT_COMMIT_SOURCE_BOOST = 1.2;

interface MessageSearchRow {
    messageOrdinal?: number | string;
    messageId?: string;
    role?: string;
    content?: string;
}

const messageSearchStatements = new WeakMap<Database, PreparedStatement>();

export interface UnifiedSearchOptions {
    limit?: number;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    readMessages?: (sessionId: string) => RawMessage[];
    embedQuery?: (text: string) => Promise<Float32Array | null>;
    isEmbeddingRuntimeEnabled?: () => boolean;
    /** Only return message-history hits with ordinal ≤ this value (e.g. last compartment end). -1 or omit to search all. */
    maxMessageOrdinal?: number;
    /** Include indexed git commits in the result set. Default false — the
     *  feature is gated behind experimental.git_commit_indexing config. */
    gitCommitsEnabled?: boolean;
}

export interface MemorySearchResult {
    source: "memory";
    content: string;
    score: number;
    memoryId: number;
    category: string;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface FactSearchResult {
    source: "fact";
    content: string;
    score: number;
    factId: number;
    factCategory: string;
}

export interface MessageSearchResult {
    source: "message";
    content: string;
    score: number;
    messageOrdinal: number;
    messageId: string;
    role: string;
}

export interface GitCommitSearchResult {
    source: "git_commit";
    content: string;
    score: number;
    sha: string;
    shortSha: string;
    author: string | null;
    committedAtMs: number;
    matchType: "semantic" | "fts" | "hybrid";
}

export type UnifiedSearchResult =
    | MemorySearchResult
    | FactSearchResult
    | MessageSearchResult
    | GitCommitSearchResult;

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_UNIFIED_SEARCH_LIMIT;
    }
    return Math.max(1, Math.floor(limit));
}

function normalizeCosineScore(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }

    return Math.min(1, Math.max(0, score));
}

function previewText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= RESULT_PREVIEW_LIMIT) {
        return normalized;
    }
    return `${normalized.slice(0, RESULT_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

function tokenizeQuery(query: string): string[] {
    return Array.from(
        new Set(
            query
                .toLowerCase()
                .split(/\s+/)
                .map((token) => token.trim())
                .filter((token) => token.length > 0),
        ),
    );
}

function scoreTextMatch(content: string, query: string, extraText = ""): number {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) {
        return 0;
    }

    const haystack = `${content} ${extraText}`.toLowerCase();
    const queryLower = query.trim().toLowerCase();
    let matchedTokens = 0;

    for (const token of tokens) {
        if (haystack.includes(token)) {
            matchedTokens++;
        }
    }

    if (matchedTokens === 0) {
        return 0;
    }

    let score = matchedTokens / tokens.length;
    if (queryLower.length > 0 && haystack.includes(queryLower)) {
        score += 0.35;
    }

    return Math.min(1, score);
}

function getMessageSearchStatement(db: Database): PreparedStatement {
    let stmt = messageSearchStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?",
        );
        messageSearchStatements.set(db, stmt);
    }
    return stmt;
}

function getMessageOrdinal(value: number | string | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

async function getSemanticScores(args: {
    db: Database;
    projectPath: string;
    query: string;
    memories: Memory[];
    embeddingEnabled: boolean;
    embedQuery: (text: string) => Promise<Float32Array | null>;
    isEmbeddingRuntimeEnabled: () => boolean;
}): Promise<Map<number, number>> {
    const semanticScores = new Map<number, number>();

    if (!args.embeddingEnabled || !args.isEmbeddingRuntimeEnabled() || args.memories.length === 0) {
        return semanticScores;
    }

    const queryEmbedding = await args.embedQuery(args.query);
    if (!queryEmbedding) {
        return semanticScores;
    }

    const cachedEmbeddings = getProjectEmbeddings(args.db, args.projectPath);
    const embeddings = await ensureMemoryEmbeddings({
        db: args.db,
        memories: args.memories,
        existingEmbeddings: cachedEmbeddings,
    });

    for (const memory of args.memories) {
        const memoryEmbedding = embeddings.get(memory.id);
        if (!memoryEmbedding) {
            continue;
        }

        semanticScores.set(
            memory.id,
            normalizeCosineScore(cosineSimilarity(queryEmbedding, memoryEmbedding)),
        );
    }

    return semanticScores;
}

function getFtsMatches(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
}): Memory[] {
    try {
        return searchMemoriesFTS(args.db, args.projectPath, args.query, args.limit);
    } catch (error) {
        log(
            `[search] FTS query failed for "${args.query}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
    }
}

function getFtsScores(matches: Memory[]): Map<number, number> {
    return new Map(matches.map((memory, rank) => [memory.id, 1 / (rank + 1)]));
}

function selectSemanticCandidates(args: {
    memories: Memory[];
    projectPath: string;
    ftsMatches: Memory[];
}): Memory[] {
    if (args.ftsMatches.length === 0) {
        return args.memories;
    }

    const candidateIds = new Set(args.ftsMatches.map((memory) => memory.id));
    const cachedEmbeddings = peekProjectEmbeddings(args.projectPath);

    if (cachedEmbeddings) {
        for (const memoryId of cachedEmbeddings.keys()) {
            candidateIds.add(memoryId);
        }
    }

    return args.memories.filter((memory) => candidateIds.has(memory.id));
}

function mergeMemoryResults(args: {
    memories: Memory[];
    semanticScores: Map<number, number>;
    ftsScores: Map<number, number>;
    limit: number;
}): MemorySearchResult[] {
    const memoryById = new Map(args.memories.map((memory) => [memory.id, memory]));
    const candidateIds = new Set<number>([...args.semanticScores.keys(), ...args.ftsScores.keys()]);
    const results: MemorySearchResult[] = [];

    for (const id of candidateIds) {
        const memory = memoryById.get(id);
        if (!memory) {
            continue;
        }

        const semanticScore = args.semanticScores.get(id);
        const ftsScore = args.ftsScores.get(id);
        let score = 0;
        let matchType: MemorySearchResult["matchType"] = "fts";

        if (semanticScore !== undefined && ftsScore !== undefined) {
            score = SEMANTIC_WEIGHT * semanticScore + FTS_WEIGHT * ftsScore;
            matchType = "hybrid";
        } else if (semanticScore !== undefined) {
            score = semanticScore * SINGLE_SOURCE_PENALTY;
            matchType = "semantic";
        } else if (ftsScore !== undefined) {
            score = ftsScore * SINGLE_SOURCE_PENALTY;
            matchType = "fts";
        }

        if (score <= 0) {
            continue;
        }

        results.push({
            source: "memory",
            content: previewText(memory.content),
            score,
            memoryId: memory.id,
            category: memory.category,
            matchType,
        });
    }

    return results
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.memoryId - right.memoryId;
        })
        .slice(0, args.limit);
}

async function searchMemories(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    memoryEnabled: boolean;
    embeddingEnabled: boolean;
    embedQuery: (text: string) => Promise<Float32Array | null>;
    isEmbeddingRuntimeEnabled: () => boolean;
}): Promise<MemorySearchResult[]> {
    if (!args.memoryEnabled) {
        return [];
    }

    const memories = getMemoriesByProject(args.db, args.projectPath);
    if (memories.length === 0) {
        return [];
    }

    const ftsMatches = getFtsMatches({
        db: args.db,
        projectPath: args.projectPath,
        query: args.query,
        limit: FTS_SEMANTIC_CANDIDATE_LIMIT,
    });
    const ftsScores = getFtsScores(ftsMatches);
    const semanticCandidates = selectSemanticCandidates({
        memories,
        projectPath: args.projectPath,
        ftsMatches,
    });
    const semanticScores = await getSemanticScores({
        db: args.db,
        projectPath: args.projectPath,
        query: args.query,
        memories: semanticCandidates,
        embeddingEnabled: args.embeddingEnabled,
        embedQuery: args.embedQuery,
        isEmbeddingRuntimeEnabled: args.isEmbeddingRuntimeEnabled,
    });

    return mergeMemoryResults({
        memories,
        semanticScores,
        ftsScores,
        limit: args.limit,
    });
}

function searchFacts(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
}): FactSearchResult[] {
    return getSessionFacts(args.db, args.sessionId)
        .map((fact: SessionFact) => ({
            fact,
            score: scoreTextMatch(fact.content, args.query, fact.category),
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            return left.fact.id - right.fact.id;
        })
        .slice(0, args.limit)
        .map(({ fact, score }) => ({
            source: "fact",
            content: previewText(fact.content),
            score,
            factId: fact.id,
            factCategory: fact.category,
        }));
}

function searchMessages(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
    readMessages: (sessionId: string) => RawMessage[];
    /** Only return messages with ordinal ≤ this value. Omit or -1 to search all indexed messages. */
    maxOrdinal?: number;
}): MessageSearchResult[] {
    ensureMessagesIndexed(args.db, args.sessionId, args.readMessages);

    const sanitizedQuery = sanitizeFtsQuery(args.query.trim());
    if (sanitizedQuery.length === 0) {
        return [];
    }

    // Fetch more rows than needed so post-filter still has enough results
    const fetchLimit =
        args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.limit * 3 : args.limit;
    const rows = getMessageSearchStatement(args.db)
        .all(args.sessionId, sanitizedQuery, fetchLimit)
        .map((row) => row as MessageSearchRow);

    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;

    return rows
        .map((row, rank) => {
            const messageOrdinal = getMessageOrdinal(row.messageOrdinal);
            if (
                messageOrdinal === null ||
                typeof row.messageId !== "string" ||
                typeof row.role !== "string" ||
                typeof row.content !== "string"
            ) {
                return null;
            }

            // Skip messages still in the live context (not yet compartmentalized)
            if (cutoff !== null && messageOrdinal > cutoff) {
                return null;
            }

            return {
                source: "message" as const,
                content: previewText(row.content),
                score: 1 / (rank + 1),
                messageOrdinal,
                messageId: row.messageId,
                role: row.role,
            };
        })
        .filter((result): result is MessageSearchResult => result !== null)
        .slice(0, args.limit);
}

function getSourceBoost(result: UnifiedSearchResult): number {
    switch (result.source) {
        case "memory":
            return MEMORY_SOURCE_BOOST;
        case "fact":
            return FACT_SOURCE_BOOST;
        case "message":
            return MESSAGE_SOURCE_BOOST;
        case "git_commit":
            return GIT_COMMIT_SOURCE_BOOST;
    }
}

function compareUnifiedResults(left: UnifiedSearchResult, right: UnifiedSearchResult): number {
    const leftEffective = left.score * getSourceBoost(left);
    const rightEffective = right.score * getSourceBoost(right);

    if (rightEffective !== leftEffective) {
        return rightEffective - leftEffective;
    }

    if (left.source === "memory" && right.source === "memory") {
        return left.memoryId - right.memoryId;
    }

    if (left.source === "fact" && right.source === "fact") {
        return left.factId - right.factId;
    }

    if (left.source === "message" && right.source === "message") {
        return left.messageOrdinal - right.messageOrdinal;
    }

    if (left.source === "git_commit" && right.source === "git_commit") {
        // Newer commits win ties.
        return right.committedAtMs - left.committedAtMs;
    }

    return 0;
}

function toGitCommitResult(hit: GitCommitSearchHit): GitCommitSearchResult {
    return {
        source: "git_commit",
        content: previewText(hit.commit.message),
        score: hit.score,
        sha: hit.commit.sha,
        shortSha: hit.commit.shortSha,
        author: hit.commit.author,
        committedAtMs: hit.commit.committedAtMs,
        matchType: hit.matchType,
    };
}

async function searchGitCommitsAsync(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    embeddingEnabled: boolean;
    embedQuery: (text: string) => Promise<Float32Array | null>;
    isEmbeddingRuntimeEnabled: () => boolean;
}): Promise<GitCommitSearchResult[]> {
    if (args.limit <= 0) return [];

    let queryEmbedding: Float32Array | null = null;
    if (args.embeddingEnabled && args.isEmbeddingRuntimeEnabled()) {
        try {
            queryEmbedding = await args.embedQuery(args.query);
        } catch (error) {
            log(
                `[search] git commit query embedding failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    const hits = searchGitCommitsSync(args.db, args.projectPath, args.query, {
        limit: args.limit,
        queryEmbedding,
    });
    return hits.map(toGitCommitResult);
}

export async function unifiedSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult[]> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        return [];
    }

    const limit = normalizeLimit(options.limit);
    const tierLimit = Math.max(limit * 3, DEFAULT_UNIFIED_SEARCH_LIMIT);

    const embeddingEnabled = options.embeddingEnabled ?? true;
    const embedQuery = options.embedQuery ?? embedText;
    const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? isEmbeddingEnabled;
    const gitCommitsEnabled = options.gitCommitsEnabled ?? false;

    const [memoryResults, factResults, messageResults, gitCommitResults] = await Promise.all([
        searchMemories({
            db,
            projectPath,
            query: trimmedQuery,
            limit: tierLimit,
            memoryEnabled: options.memoryEnabled ?? true,
            embeddingEnabled,
            embedQuery,
            isEmbeddingRuntimeEnabled,
        }),
        Promise.resolve(searchFacts({ db, sessionId, query: trimmedQuery, limit: tierLimit })),
        Promise.resolve(
            searchMessages({
                db,
                sessionId,
                query: trimmedQuery,
                limit: tierLimit,
                readMessages: options.readMessages ?? readRawSessionMessages,
                maxOrdinal: options.maxMessageOrdinal,
            }),
        ),
        gitCommitsEnabled
            ? searchGitCommitsAsync({
                  db,
                  projectPath,
                  query: trimmedQuery,
                  limit: tierLimit,
                  embeddingEnabled,
                  embedQuery,
                  isEmbeddingRuntimeEnabled,
              })
            : Promise.resolve([] as GitCommitSearchResult[]),
    ]);

    const results = [...memoryResults, ...factResults, ...messageResults, ...gitCommitResults]
        .sort(compareUnifiedResults)
        .slice(0, limit);

    const memoryIds = results
        .filter((result): result is MemorySearchResult => result.source === "memory")
        .map((result) => result.memoryId);

    if (memoryIds.length > 0) {
        db.transaction(() => {
            for (const memoryId of memoryIds) {
                updateMemoryRetrievalCount(db, memoryId);
            }
        })();
    }

    return results;
}
