// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export * from "#geocode/core"
export * from "#geocode/options"
export { type GeocodeClassifier } from "#geocode/classifier"
export * from "#geocode/diff"
export * from "#geocode/layers/national-overture"
export * from "#geocode/layers/regions"
export * from "#geocode/result"
export * from "#geocode/session"
export { type CapitalTier } from "#engine/resolver-backend"
export * from "#geocode/batch/stream"
export * from "#geocode/options/switches"
export * from "#geocode/tree-reads"
export * from "#geocode/rewrites/bare-postcode"

// `#geocode/batch/worker` is deliberately absent.
// It is a worker-thread entry rather than a library module: its body destructures
// `workerData` at import, so pulling it through this barrel runs it on the main thread
// and throws before any test reaches an assertion.
// Entries are spawned by path.
// Only `stream.ts` names it.
export * from "#geocode/result/derivation"
export * from "#geocode/result/epistemic-status"
