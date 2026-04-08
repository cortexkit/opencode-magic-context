import type { Database } from "bun:sqlite";
import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import { cosineSimilarity } from "./cosine-similarity";
import { LocalEmbeddingProvider } from "./embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";
import type { EmbeddingProvider } from "./embedding-provider";
import { computeNormalizedHash } from "./normalize-hash";
import { saveEmbedding } from "./storage-memory-embeddings";

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
    provider: "local",
    model: DEFAULT_LOCAL_EMBEDDING_MODEL,
};

let embeddingConfig: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG;
let provider: EmbeddingProvider | null = null;

type PreparedStatement = ReturnType<Database["prepare"]>;

interface UnembeddedMemoryRow {
    id: number;
    content: string;
}

const loadUnembeddedMemoriesStatements = new WeakMap<Database, PreparedStatement>();

function isUnembeddedMemoryRow(row: unknown): row is UnembeddedMemoryRow {
    if (row === null || typeof row !== "object") {
        return false;
    }

    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "number" && typeof candidate.content === "string";
}

function getLoadUnembeddedMemoriesStatement(db: Database): PreparedStatement {
    let stmt = loadUnembeddedMemoriesStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT m.id AS id, m.content AS content FROM memories m LEFT JOIN memory_embeddings me ON m.id = me.memory_id WHERE m.project_path = ? AND m.status = 'active' AND me.memory_id IS NULL LIMIT ?",
        );
        loadUnembeddedMemoriesStatements.set(db, stmt);
    }

    return stmt;
}

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
        };
    }

    return { provider: "off" };
}

function resolveModelId(config: EmbeddingConfig): string {
    if (config.provider === "off") {
        return "off";
    }

    if (config.provider === "openai-compatible") {
        const endpoint = config.endpoint.trim();
        const model = config.model.trim();
        const keyHash = config.api_key ? computeNormalizedHash(config.api_key) : "nokey";
        return `openai-compat:${endpoint}:${model}:${keyHash}`;
    }

    return config.model.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL;
}

function createProvider(config: EmbeddingConfig): EmbeddingProvider | null {
    if (config.provider === "off") {
        return null;
    }

    if (config.provider === "openai-compatible") {
        return new OpenAICompatibleEmbeddingProvider({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.api_key,
        });
    }

    return new LocalEmbeddingProvider(config.model);
}

function getOrCreateProvider(): EmbeddingProvider | null {
    if (provider) {
        return provider;
    }

    provider = createProvider(embeddingConfig);
    return provider;
}

export function initializeEmbedding(config: EmbeddingConfig): void {
    const nextConfig = resolveEmbeddingConfig(config);
    const nextModelId = resolveModelId(nextConfig);
    const previousProvider = provider;
    const previousModelId = previousProvider?.modelId ?? resolveModelId(embeddingConfig);

    if (previousModelId === nextModelId) {
        embeddingConfig = nextConfig;
        return;
    }

    embeddingConfig = nextConfig;
    provider = null;

    if (previousProvider) {
        void previousProvider.dispose().catch((error) => {
            log("[magic-context] embedding provider dispose failed:", error);
        });
    }
}

export function isEmbeddingEnabled(): boolean {
    return embeddingConfig.provider !== "off";
}

export async function ensureEmbeddingModel(): Promise<boolean> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return false;
    }

    return currentProvider.initialize();
}

export async function embedText(text: string): Promise<Float32Array | null> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return null;
    }

    if (!(await currentProvider.initialize())) {
        return null;
    }

    return currentProvider.embed(text);
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) {
        return [];
    }

    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return Array.from({ length: texts.length }, () => null);
    }

    if (!(await currentProvider.initialize())) {
        return Array.from({ length: texts.length }, () => null);
    }

    return currentProvider.embedBatch(texts);
}

export async function embedUnembeddedMemories(
    db: Database,
    projectPath: string,
    config: EmbeddingConfig,
    batchSize = 10,
): Promise<number> {
    return embedUnembeddedMemoriesForProject(db, projectPath, config, batchSize);
}

/**
 * Sweep ALL projects for unembedded memories, not just one project.
 * Used by the dream timer to ensure cross-project embedding coverage.
 */
export async function embedAllUnembeddedMemories(
    db: Database,
    config: EmbeddingConfig,
    batchSize = 10,
): Promise<number> {
    const resolvedConfig = resolveEmbeddingConfig(config);
    if (resolvedConfig.provider === "off") return 0;

    const projects = db
        .prepare(
            `SELECT DISTINCT m.project_path FROM memories m
             WHERE m.status IN ('active', 'permanent')
             AND m.id NOT IN (SELECT memory_id FROM memory_embeddings)
             LIMIT 20`,
        )
        .all() as Array<{ project_path: string }>;

    let total = 0;
    for (const row of projects) {
        const count = await embedUnembeddedMemoriesForProject(
            db,
            row.project_path,
            config,
            batchSize,
        );
        total += count;
    }
    return total;
}

async function embedUnembeddedMemoriesForProject(
    db: Database,
    projectPath: string,
    config: EmbeddingConfig,
    batchSize = 10,
): Promise<number> {
    const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
    const resolvedConfig = resolveEmbeddingConfig(config);

    if (resolvedConfig.provider === "off") {
        return 0;
    }

    initializeEmbedding(resolvedConfig);

    const memories = getLoadUnembeddedMemoriesStatement(db)
        .all(projectPath, normalizedBatchSize)
        .filter(isUnembeddedMemoryRow);
    if (memories.length === 0) {
        return 0;
    }

    try {
        const embeddings = await embedBatch(memories.map((memory) => memory.content));
        const modelId = getEmbeddingModelId();
        if (modelId === "off") {
            return 0;
        }

        let embeddedCount = 0;
        db.transaction(() => {
            for (const [index, memory] of memories.entries()) {
                const embedding = embeddings[index];
                if (!embedding) {
                    continue;
                }

                saveEmbedding(db, memory.id, embedding, modelId);
                embeddedCount += 1;
            }
        })();

        return embeddedCount;
    } catch (error) {
        log("[magic-context] failed to proactively embed missing memories:", error);
        return 0;
    }
}

export function getEmbeddingModelId(): string {
    return getOrCreateProvider()?.modelId ?? "off";
}

export { cosineSimilarity };

export async function disposeEmbeddingModel(): Promise<void> {
    const currentProvider = provider;
    provider = null;

    if (!currentProvider) {
        return;
    }

    await currentProvider.dispose();
}
