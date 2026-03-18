#!/usr/bin/env bun

// Usage: bun scripts/dream.ts [--project-path <path>] [--tasks decay,consolidate]

import path from "node:path";
import { loadPluginConfig } from "../src/config";
import { MagicContextConfigSchema } from "../src/config/schema/magic-context";
import { initializeEmbedding, resolveProjectIdentity } from "../src/features/magic-context/memory";
import { closeDatabase, openDatabase } from "../src/features/magic-context/storage";
import { runDream } from "../src/features/magic-context/dreamer";

interface ParsedArgs {
    projectPath: string;
    tasks?: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
    let projectPath = process.cwd();
    let tasks: string[] | undefined;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--project-path") {
            const value = argv[index + 1];
            if (!value) {
                throw new Error("Missing value for --project-path");
            }
            projectPath = path.resolve(value);
            index += 1;
            continue;
        }

        if (arg === "--tasks") {
            const value = argv[index + 1];
            if (!value) {
                throw new Error("Missing value for --tasks");
            }
            tasks = value
                .split(",")
                .map((task) => task.trim())
                .filter((task) => task.length > 0);
            index += 1;
        }
    }

    return { projectPath, tasks };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const pluginConfig = MagicContextConfigSchema.parse(loadPluginConfig(args.projectPath));
    const db = openDatabase();

    initializeEmbedding(pluginConfig.embedding);

    const projectIdentity = resolveProjectIdentity(args.projectPath);
    const result = await runDream({
        db,
        projectPath: projectIdentity,
        tasks: args.tasks ?? pluginConfig.dreaming?.tasks ?? ["decay", "consolidate"],
        promotionThreshold: pluginConfig.memory.retrieval_count_promotion_threshold,
        maxRuntimeMinutes: pluginConfig.dreaming?.max_runtime_minutes ?? 120,
    });

    console.log(JSON.stringify(result, null, 2));
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    })
    .finally(() => {
        closeDatabase();
    });
