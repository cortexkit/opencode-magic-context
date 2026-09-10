import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	addNativeReasoningIds,
	getNativeReasoningIds,
	getNativeToolInputs,
	saveNativeToolInputs,
} from "@magic-context/core/features/magic-context/storage-native-replay";
import { sessionLog } from "@magic-context/core/shared/logger";
import { isRecord } from "@magic-context/core/shared/record-type-guard";
import {
	clearNativeReasoning,
	rewriteNativeToolInput,
} from "./native-replay-pi";
import { SYNTH_USER_ID_PREFIX } from "./read-session-pi";

type ReplayArgs = {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
};

/** Replay frozen inputs first; publish new native bytes only after their write succeeds. */
export function applyNativeToolInputReplayPi(
	args: ReplayArgs & {
		changes: ReadonlyMap<number, ReadonlySet<string>>;
		canApply: boolean;
	},
): number {
	const saved = getNativeToolInputs(args.db, args.sessionId);
	if (saved.size === 0 && (!args.canApply || args.changes.size === 0)) return 0;
	const nextInputs = new Map<string, string>();
	const pending = new Map<number, Record<string, unknown>>();

	for (let index = 0; index < args.messages.length; index++) {
		const original = args.messages[index];
		if (
			!isRecord(original) ||
			original.role !== "assistant" ||
			!Array.isArray(original.content) ||
			original.providerPayload == null
		)
			continue;
		const calls = original.content.filter(
			(part): part is Record<string, unknown> =>
				isRecord(part) &&
				part.type === "toolCall" &&
				typeof part.id === "string",
		);
		let replay = original;
		for (const call of calls) {
			const input = saved.get(call.id as string);
			if (input === undefined) continue;
			const parsed: unknown = JSON.parse(input);
			if (!isRecord(parsed))
				throw new Error("Invalid persisted native tool input");
			const candidate = { ...replay };
			rewriteNativeToolInput(candidate, call.id as string, parsed);
			if (candidate.providerPayload !== replay.providerPayload)
				replay = candidate;
		}
		args.messages[index] = replay;
		if (!args.canApply) continue;
		const changed = args.changes.get(index);
		if (!changed) continue;

		let next = replay;
		for (const call of calls) {
			const id = call.id as string;
			if (!changed.has(id) || !isRecord(call.arguments)) continue;
			let serialized: string | undefined;
			try {
				serialized = JSON.stringify(call.arguments);
			} catch {
				continue;
			}
			if (serialized === undefined || saved.get(id) === serialized) continue;
			const normalized: unknown = JSON.parse(serialized);
			if (!isRecord(normalized)) continue;
			const candidate = { ...next };
			rewriteNativeToolInput(candidate, id, normalized);
			if (candidate.providerPayload === next.providerPayload) continue;
			next = candidate;
			nextInputs.set(id, serialized);
		}
		if (next !== replay) pending.set(index, next);
	}

	if (nextInputs.size === 0) return 0;
	try {
		saveNativeToolInputs(args.db, args.sessionId, nextInputs);
	} catch (error) {
		sessionLog(
			args.sessionId,
			`native input activation failed; retaining previous replay: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 0;
	}
	for (const [index, message] of pending) args.messages[index] = message;
	return nextInputs.size;
}

/** Native reasoning has its own durable decisions, independent of the local watermark. */
export function applyNativeReasoningReplayPi(
	args: ReplayArgs & {
		messageIdToMaxTag: ReadonlyMap<string, number>;
		stableId: (message: unknown, index: number) => string | undefined;
		localWatermark: number;
		clearReasoningAge: number;
		omissionAllowed: boolean;
		canApply: boolean;
		detectAged: boolean;
	},
): number {
	if (!args.omissionAllowed) return 0;
	const saved = getNativeReasoningIds(args.db, args.sessionId);
	let maxTag = 0;
	for (const tag of args.messageIdToMaxTag.values())
		maxTag = Math.max(maxTag, tag);
	const cutoff = args.detectAged
		? Math.max(args.localWatermark, maxTag - args.clearReasoningAge)
		: args.localWatermark;
	const nextIds = new Set<string>();
	const pending = new Map<number, Record<string, unknown>>();

	for (let index = 0; index < args.messages.length; index++) {
		const original = args.messages[index];
		if (!isRecord(original) || original.role !== "assistant") continue;
		const id = args.stableId(original, index);
		// Positional fallback IDs drift before adoption; they cannot own durable replay.
		if (!id || id.startsWith("pi-msg-") || id.startsWith(SYNTH_USER_ID_PREFIX))
			continue;
		const replay = saved.has(id);
		const tag = args.messageIdToMaxTag.get(id) ?? 0;
		if (!replay && (!args.canApply || tag === 0 || tag > cutoff)) continue;
		const candidate = { ...original };
		if (clearNativeReasoning(candidate, true) !== "cleared") continue;
		if (replay) {
			args.messages[index] = candidate;
		} else {
			nextIds.add(id);
			pending.set(index, candidate);
		}
	}

	if (nextIds.size === 0) return 0;
	try {
		addNativeReasoningIds(args.db, args.sessionId, nextIds);
	} catch (error) {
		sessionLog(
			args.sessionId,
			`native reasoning activation failed; retaining previous replay: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 0;
	}
	for (const [index, message] of pending) args.messages[index] = message;
	return nextIds.size;
}
