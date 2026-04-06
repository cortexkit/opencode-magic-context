import type { BuiltinCommandConfig } from "./types";

/** Only display-only commands that are fully replaced by TUI-native UI (e.g. dialog).
 * Action commands (flush, aug, dream, recomp) must stay server-side because the
 * server-side command.execute.before hook does the actual work. */
const TUI_OVERRIDE_COMMANDS = new Set(["ctx-status"]);

export function getMagicContextBuiltinCommands(): BuiltinCommandConfig {
    const isTui = process.env.OPENCODE_CLIENT === "cli";

    const commands: BuiltinCommandConfig = {
        "ctx-status": {
            template: "ctx-status",
            description: "Show magic context status, pending queue, cache TTL, and debug info",
        },
        "ctx-recomp": {
            template: "ctx-recomp",
            description:
                "Rebuild compartments and facts from raw history without publishing partial results",
        },
        "ctx-flush": {
            template: "ctx-flush",
            description: "Force-process all pending magic context operations immediately",
        },
        "ctx-aug": {
            template: "ctx-aug",
            description: "Augment your prompt with project memory context via sidekick agent",
        },
        "ctx-dream": {
            template: "ctx-dream",
            description: "Run the hidden dreamer maintenance pass for this project now",
        },
    };

    // In TUI mode, skip commands that have richer TUI-native implementations
    if (isTui) {
        for (const name of TUI_OVERRIDE_COMMANDS) {
            delete commands[name];
        }
    }

    return commands;
}
