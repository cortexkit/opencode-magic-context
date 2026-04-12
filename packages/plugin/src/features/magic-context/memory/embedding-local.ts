import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { getOpenCodeStorageDir } from "../../../shared/data-path";
import { log } from "../../../shared/logger";
import type { EmbeddingProvider } from "./embedding-provider";

type EmbeddingPipelineResult = {
    data: ArrayLike<number> | ArrayLike<number>[];
    dims?: number[];
};

type EmbeddingPipeline = {
    (
        input: string | string[],
        options: { pooling: "mean"; normalize: true },
    ): Promise<EmbeddingPipelineResult>;
    dispose?: () => Promise<void> | void;
};

type CreateEmbeddingPipeline = (
    task: "feature-extraction",
    model: string,
    options: { quantized: boolean; dtype: string },
) => Promise<EmbeddingPipeline>;

/**
 * Temporarily redirects console.warn and console.error to the file logger
 * so that @huggingface/transformers and ONNX runtime never leak to the TUI.
 */
async function withQuietConsole<T>(fn: () => Promise<T>): Promise<T> {
    const origWarn = console.warn;
    const origError = console.error;
    const redirect = (...args: unknown[]) => {
        const message = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
        log(`[transformers] ${message}`);
    };
    console.warn = redirect;
    console.error = redirect;
    try {
        return await fn();
    } finally {
        console.warn = origWarn;
        console.error = origError;
    }
}

/**
 * Recognizes transient ONNX/transformers load failures that should be retried
 * rather than surfaced to the user. Seen in live logs when multiple plugin
 * processes (Desktop sidecar + TUI + dashboard) initialize the embedding
 * pipeline within the same window. The on-disk model file is intact; the
 * failure mode is ephemeral and resolves on retry.
 */
function isTransientLoadError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!message) return false;
    const lower = message.toLowerCase();
    return (
        lower.includes("protobuf parsing failed") ||
        lower.includes("unable to get model file path or buffer") ||
        lower.includes("ebusy") ||
        lower.includes("resource busy") ||
        lower.includes("resource temporarily unavailable")
    );
}

function isArrayLikeNumber(value: unknown): value is ArrayLike<number> {
    if (typeof value !== "object" || value === null || !("length" in value)) {
        return false;
    }
    const arr = value as { length: unknown; [key: number]: unknown };
    if (typeof arr.length !== "number") {
        return false;
    }
    // Verify a sample element is numeric (or array is empty)
    return arr.length === 0 || typeof arr[0] === "number";
}

function toFloat32Array(values: ArrayLike<number>): Float32Array {
    // Intentional: defensive copy for Float32Array inputs prevents mutation of pipeline output.
    // The one-time copy cost is negligible compared to inference cost.
    return values instanceof Float32Array
        ? new Float32Array(values)
        : Float32Array.from(Array.from(values));
}

function extractBatchEmbeddings(
    result: EmbeddingPipelineResult,
    expectedCount: number,
): (Float32Array | null)[] {
    const { data } = result;

    if (
        Array.isArray(data) &&
        data.length === expectedCount &&
        data.every((entry) => typeof entry !== "number" && isArrayLikeNumber(entry))
    ) {
        return data.map((entry) => toFloat32Array(entry));
    }

    if (!isArrayLikeNumber(data)) {
        log("[magic-context] embedding batch returned unexpected data shape");
        return Array.from({ length: expectedCount }, () => null);
    }

    const flatData = toFloat32Array(data);
    const dimension = result.dims?.at(-1) ?? flatData.length / expectedCount;

    if (
        !Number.isInteger(dimension) ||
        dimension <= 0 ||
        flatData.length !== expectedCount * dimension
    ) {
        log("[magic-context] embedding batch returned invalid dimensions");
        return Array.from({ length: expectedCount }, () => null);
    }

    const embeddings: Float32Array[] = [];
    for (let index = 0; index < expectedCount; index++) {
        embeddings.push(flatData.slice(index * dimension, (index + 1) * dimension));
    }

    return embeddings;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;

    private readonly model: string;
    private pipeline: EmbeddingPipeline | null = null;
    private initPromise: Promise<void> | null = null;

    constructor(model = DEFAULT_LOCAL_EMBEDDING_MODEL) {
        this.model = model;
        this.modelId = `local:${model}`;
    }

    async initialize(): Promise<boolean> {
        if (this.pipeline) {
            return true;
        }

        if (this.initPromise) {
            await this.initPromise;
            return this.pipeline !== null;
        }

        this.initPromise = (async () => {
            try {
                // Non-literal import specifier prevents Bun from eagerly resolving
                // @huggingface/transformers at plugin load time. Desktop sidecar spawns
                // hit ENOENT on JSDoc-referenced files inside transformers' webpack dist
                // when the literal string triggers Bun's static module analysis.
                // See: https://github.com/cortexkit/opencode-magic-context/issues/4
                const transformersSpec = `@huggingface/${"transformers"}`;
                const transformersModule = (await import(transformersSpec)) as Record<
                    string,
                    unknown
                >;
                const env = transformersModule.env as {
                    logLevel?: unknown;
                    cacheDir?: string;
                };
                const LogLevel = transformersModule.LogLevel as Record<string, unknown> | undefined;
                if (LogLevel && "ERROR" in LogLevel) {
                    env.logLevel = LogLevel.ERROR;
                }

                // Set a stable model cache directory outside of node_modules.
                // On Windows, the default .cache inside the npm cached install
                // (e.g. ~\.cache\opencode\packages\...\node_modules\@huggingface\transformers\.cache)
                // can be inaccessible or non-writable, causing "Unable to get model file path
                // or buffer" failures. Using our own storage dir survives plugin updates too.
                const modelCacheDir = join(
                    getOpenCodeStorageDir(),
                    "plugin",
                    "magic-context",
                    "models",
                );
                try {
                    mkdirSync(modelCacheDir, { recursive: true });
                    env.cacheDir = modelCacheDir;
                } catch {
                    // Non-fatal — fall back to library default if we can't create the dir
                    log("[magic-context] could not create model cache dir, using library default");
                }
                const createPipeline = transformersModule.pipeline as CreateEmbeddingPipeline;

                // Retry loop absorbs transient failures seen when multiple plugin
                // processes initialize the ONNX session around the same time:
                //   - "Protobuf parsing failed" (onnxruntime-node race on mmap/page cache)
                //   - "Unable to get model file path or buffer" (download still in progress)
                //   - EBUSY / file lock contention
                // Recovery happens within a few hundred ms. The file on disk is fine;
                // we verified this on live logs with matching SHA256 vs HuggingFace.
                const MAX_ATTEMPTS = 3;
                let lastError: unknown;
                for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    try {
                        this.pipeline = await withQuietConsole(() =>
                            createPipeline("feature-extraction", this.model, {
                                quantized: true,
                                dtype: "fp32",
                            }),
                        );
                        lastError = undefined;
                        break;
                    } catch (error) {
                        lastError = error;
                        if (!isTransientLoadError(error) || attempt === MAX_ATTEMPTS) {
                            break;
                        }
                        // Jittered backoff: 300ms + random 0-200ms, grows by attempt.
                        const delayMs = 300 * attempt + Math.floor(Math.random() * 200);
                        log(
                            `[magic-context] embedding model load attempt ${attempt}/${MAX_ATTEMPTS} failed transiently, retrying in ${delayMs}ms`,
                        );
                        await new Promise((resolve) => setTimeout(resolve, delayMs));
                    }
                }

                if (this.pipeline) {
                    log(`[magic-context] embedding model loaded: ${this.model}`);
                } else {
                    throw lastError ?? new Error("unknown embedding load failure");
                }
            } catch (error) {
                log("[magic-context] embedding model failed to load:", error);
                this.pipeline = null;
            } finally {
                this.initPromise = null;
            }
        })();

        await this.initPromise;
        return this.pipeline !== null;
    }

    async embed(text: string): Promise<Float32Array | null> {
        if (!(await this.initialize())) {
            return null;
        }

        try {
            const pipeline = this.pipeline;
            if (!pipeline) {
                return null;
            }

            const result = await withQuietConsole(() =>
                pipeline(text, {
                    pooling: "mean",
                    normalize: true,
                }),
            );

            return extractBatchEmbeddings(result, 1)[0] ?? null;
        } catch (error) {
            log("[magic-context] embedding failed:", error);
            return null;
        }
    }

    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) {
            return [];
        }

        if (!(await this.initialize())) {
            return Array.from({ length: texts.length }, () => null);
        }

        try {
            const pipeline = this.pipeline;
            if (!pipeline) {
                return Array.from({ length: texts.length }, () => null);
            }

            const result = await withQuietConsole(() =>
                pipeline(texts, {
                    pooling: "mean",
                    normalize: true,
                }),
            );

            return extractBatchEmbeddings(result, texts.length);
        } catch (error) {
            log("[magic-context] embedding batch failed:", error);
            return Array.from({ length: texts.length }, () => null);
        }
    }

    async dispose(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }

        if (!this.pipeline) {
            this.pipeline = null;
            this.initPromise = null;
            return;
        }

        try {
            await this.pipeline.dispose?.();
        } catch (error) {
            log("[magic-context] embedding model dispose failed:", error);
        } finally {
            this.pipeline = null;
            this.initPromise = null;
        }
    }

    isLoaded(): boolean {
        return this.pipeline !== null;
    }
}
