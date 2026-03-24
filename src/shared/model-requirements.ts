import { DREAMER_AGENT } from "../agents/dreamer";
import { HISTORIAN_AGENT } from "../agents/historian";
import { SIDEKICK_AGENT } from "../agents/sidekick";

export interface AgentModelRequirement {
    fallback_models: string[];
}

const DEFAULT_UTILITY_FALLBACKS = ["anthropic/claude-3-5-haiku", "openai/gpt-4.1-mini"] as const;

export const AGENT_MODEL_REQUIREMENTS: Record<string, AgentModelRequirement> = {
    [HISTORIAN_AGENT]: {
        fallback_models: [...DEFAULT_UTILITY_FALLBACKS],
    },
    [DREAMER_AGENT]: {
        fallback_models: [...DEFAULT_UTILITY_FALLBACKS],
    },
    [SIDEKICK_AGENT]: {
        fallback_models: [...DEFAULT_UTILITY_FALLBACKS],
    },
};

export function getAgentFallbackModels(agent: string): string[] | undefined {
    return AGENT_MODEL_REQUIREMENTS[agent]?.fallback_models;
}
