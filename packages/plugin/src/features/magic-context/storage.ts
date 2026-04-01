export {
    buildCompartmentBlock,
    escapeXmlAttr,
    escapeXmlContent,
    getCompartments,
    getSessionFacts,
    replaceAllCompartmentState,
    type SessionFact,
} from "./compartment-storage";
export {
    clearCompressionDepth,
    getAverageCompressionDepth,
    getMaxCompressionDepth,
    incrementCompressionDepth,
} from "./compression-depth-storage";
export {
    clearIndexedMessages,
    deleteIndexedMessage,
} from "./message-index";
export {
    type ContextDatabase,
    closeDatabase,
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "./storage-db";
export {
    clearPersistedNoteNudge,
    clearPersistedNudgePlacement,
    clearPersistedStickyTurnReminder,
    clearSession,
    getOrCreateSessionMeta,
    getPersistedNoteNudge,
    getPersistedNudgePlacement,
    getPersistedReasoningWatermark,
    getPersistedStickyTurnReminder,
    getStrippedPlaceholderIds,
    loadPersistedUsage,
    removeStrippedPlaceholderId,
    setPersistedNudgePlacement,
    setPersistedReasoningWatermark,
    setPersistedStickyTurnReminder,
    setStrippedPlaceholderIds,
    updateSessionMeta,
} from "./storage-meta";
export {
    addSessionNote,
    clearSessionNotes,
    getSessionNotes,
    replaceAllSessionNotes,
    type SessionNote,
} from "./storage-notes";
export {
    clearPendingOps,
    getPendingOps,
    queuePendingOp,
    removePendingOp,
} from "./storage-ops";
export {
    addSmartNote,
    deleteSmartNote,
    dismissSmartNote,
    getPendingSmartNotes,
    getReadySmartNotes,
    getSmartNotes,
    markSmartNoteChecked,
    markSmartNoteReady,
    type SmartNote,
    type SmartNoteStatus,
} from "./storage-smart-notes";
export {
    getSourceContents,
    replaceSourceContent,
    saveSourceContent,
} from "./storage-source";
export {
    deleteTagsByMessageId,
    getMaxTagNumberBySession,
    getTagById,
    getTagsBySession,
    getTopNBySize,
    insertTag,
    updateTagMessageId,
    updateTagStatus,
} from "./storage-tags";
