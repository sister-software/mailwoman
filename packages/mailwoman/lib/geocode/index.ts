/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export * from "#geocode/command-options"
export * from "#geocode/core"
export * from "#geocode/diff"
export * from "#geocode/regions"
export * from "#geocode/result"
export * from "#geocode/session"
export * from "#geocode/stream"
export * from "#geocode/tree-reads"

// `#geocode/worker` is deliberately absent. It is a worker-thread ENTRY, not a library module: its body
// destructures `workerData` at import, so pulling it through this barrel runs it on the main thread and
// throws before any test reaches an assertion. Entries are spawned by path; only `stream.ts` names it.
