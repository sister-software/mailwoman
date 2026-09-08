// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export * from "#geocode/command-options"
export * from "#geocode/core"
export * from "#geocode/diff"
export * from "#geocode/national-overture"
export * from "#geocode/regions"
export * from "#geocode/result"
export * from "#geocode/session"
export * from "#geocode/stream"
export * from "#geocode/tree-reads"

// `#geocode/worker` is deliberately absent. It is a worker-thread ENTRY, not a library module: its body
// destructures `workerData` at import, so pulling it through this barrel runs it on the main thread and
// throws before any test reaches an assertion. Entries are spawned by path; only `stream.ts` names it.
export * from "#geocode/derivation"
export * from "#geocode/epistemic-status"
