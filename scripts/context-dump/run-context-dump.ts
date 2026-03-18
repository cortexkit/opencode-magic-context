import { Database } from "bun:sqlite"
import { applyTransforms } from "./apply-transforms"
import { buildDumpStats } from "./metrics"
import { createDumpFilePath, resolveContextDatabasePath, resolveOpenCodeDatabasePath } from "./database-paths"
import { readContextMetadata } from "./read-context-metadata"
import { readOpenCodeSessionMessages } from "./read-opencode-session"
import { stripMetadata } from "./strip-metadata"
import { writeDumpJsonFile } from "./write-dump-json"
import type { PendingOpRow, TransformDiagnostics } from "./types"
import { prepareCompartmentInjection, renderCompartmentInjection } from "../../src/hooks/magic-context/inject-compartments"
import type { MessageLike } from "../../src/hooks/magic-context/tag-messages"

export interface ContextDumpResult {
	sessionId: string
	outputPath: string
	openCodeDbPath: string
	contextDbPath: string
	originalChars: number
	transformedChars: number
	originalTokens: number
	transformedTokens: number
	compressionRatio: string
	messageCount: number
	cacheBustCount: number
	lastBusts: Array<{ time: string; parts: string; cache_read: number; cache_write: number }>
	pendingOps: PendingOpRow[]
	diagnostics: TransformDiagnostics
}

export async function runContextDump(sessionId: string): Promise<ContextDumpResult> {
	if (!sessionId.trim()) {
		throw new Error("session_id is required")
	}

	const openCodeDbPath = resolveOpenCodeDatabasePath()
	const contextDbPath = resolveContextDatabasePath()

	const originalMessages = stripMetadata(readOpenCodeSessionMessages(openCodeDbPath, sessionId))
	const transformedMessages = structuredClone(originalMessages)

	const { tags, pendingOps, sourceContents, isSubagent } = readContextMetadata(contextDbPath, sessionId)
	const contextDb = new Database(contextDbPath, { readonly: true })
	let diagnostics: TransformDiagnostics
	try {
		const preparedCompartmentInjection = isSubagent
			? null
			: prepareCompartmentInjection(contextDb, sessionId, transformedMessages as unknown as MessageLike[])
		const compartmentInjection = preparedCompartmentInjection
			? renderCompartmentInjection(sessionId, transformedMessages as unknown as MessageLike[], preparedCompartmentInjection)
			: { injected: false, compartmentEndMessage: -1, compartmentCount: 0, skippedVisibleMessages: 0 }
		diagnostics = applyTransforms(transformedMessages, tags, sourceContents, {
			exactMatchCount: 0,
			ordinalFallbackCount: 0,
			missingDroppedTags: [],
			compartmentInjection,
		})
	} finally {
		contextDb.close(false)
	}

	const timestamp = new Date().toISOString()
	const outputPath = await createDumpFilePath(sessionId, timestamp)
	const stats = buildDumpStats(originalMessages, transformedMessages)
	await writeDumpJsonFile({
		outputPath,
		sessionId,
		timestamp,
		originalMessages,
		transformedMessages,
		stats,
		pendingOps,
		diagnostics,
	})

	const busts = stats.perMessageCache.filter((c) => c.cache_bust)
	const lastBusts = busts.slice(-10).map((b) => {
		const time = b.time_completed
			? new Date(b.time_completed).toISOString().replace("T", " ").slice(0, 19)
			: "unknown"
		return { time, parts: b.part_types, cache_read: b.cache_read, cache_write: b.cache_write }
	})

	return {
		sessionId,
		outputPath,
		openCodeDbPath,
		contextDbPath,
		originalChars: stats.originalTotalChars,
		transformedChars: stats.transformedTotalChars,
		originalTokens: stats.originalTotalTokens,
		transformedTokens: stats.transformedTotalTokens,
		compressionRatio: stats.compressionRatio,
		messageCount: stats.messageCount,
		cacheBustCount: busts.length,
		lastBusts,
		pendingOps,
		diagnostics,
	}
}
