import type { MagicContextConfig } from "../config/schema/magic-context";
import { consumeMessages, sendTuiToast } from "../features/magic-context/plugin-messages";
import { openDatabase } from "../features/magic-context/storage";
import { executeContextRecomp } from "../hooks/magic-context/compartment-runner";
import { sendIgnoredMessage } from "../hooks/magic-context/send-session-notification";
import { log } from "../shared/logger";
import type { PluginContext } from "./types";

const DEFAULT_COMPARTMENT_TOKEN_BUDGET = 20_000;
const DEFAULT_HISTORIAN_TIMEOUT_MS = 10 * 60 * 1000;

/** Poll interval for TUI action messages (2 seconds). */
const TUI_ACTION_POLL_INTERVAL_MS = 2_000;

/**
 * Start a server-side consumer that polls plugin_messages for TUI→server
 * action messages and dispatches them. Currently handles:
 * - { command: "recomp" } — executes /ctx-recomp for the given session
 */
export function startTuiActionConsumer(args: {
    client: PluginContext["client"];
    directory: string;
    config: MagicContextConfig;
}): (() => void) | undefined {
    const { client, directory, config } = args;

    const timer = setInterval(() => {
        try {
            const db = openDatabase();
            const actions = consumeMessages(db, "tui_to_server", { type: "action" });

            for (const msg of actions) {
                const command = msg.payload.command;
                const sessionId = msg.sessionId;

                if (command === "recomp" && sessionId) {
                    log(`[magic-context] TUI action: recomp requested for session ${sessionId}`);

                    sendTuiToast(db, "Historian recomp started", {
                        variant: "info",
                        sessionId,
                    });

                    void executeContextRecomp({
                        client,
                        db,
                        sessionId,
                        tokenBudget:
                            config.compartment_token_budget ?? DEFAULT_COMPARTMENT_TOKEN_BUDGET,
                        historianTimeoutMs:
                            config.historian_timeout_ms ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
                        directory,
                        getNotificationParams: () => ({}),
                    })
                        .then((result: string) => {
                            sendTuiToast(db, "Recomp completed", { variant: "success", sessionId });
                            void sendIgnoredMessage(client, sessionId, result, {}).catch(() => {});
                        })
                        .catch((error: unknown) => {
                            log("[magic-context] TUI recomp failed:", error);
                            sendTuiToast(
                                db,
                                `Recomp failed: ${error instanceof Error ? error.message : "unknown error"}`,
                                { variant: "error", sessionId },
                            );
                        });
                } else {
                    log(
                        `[magic-context] TUI action: unknown command=${String(command)} session=${String(sessionId)}`,
                    );
                }
            }
        } catch (error) {
            log("[magic-context] TUI action consumer error:", error);
        }
    }, TUI_ACTION_POLL_INTERVAL_MS);

    if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
    }

    log("[magic-context] started TUI action consumer (2s poll)");

    return () => {
        clearInterval(timer);
    };
}
