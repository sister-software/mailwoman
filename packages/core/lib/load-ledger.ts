// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The record of one release load, one entry per artifact: what it is, the byte count
 *   that arrived, where the bytes came from and whether the load succeeded.
 *
 *   The browser runtime writes the record and a page renders it.
 *   Both read these declarations from here.
 */

/**
 * What an artifact is to the runtime that loads it.
 */
export const ArtifactRole = {
	Weights: "weights",
	Embeddings: "embeddings",
	Tokenizer: "tokenizer",
	Lexicon: "lexicon",
	ModelCard: "model-card",
	Calibration: "calibration",
	FST: "fst",
	PairIndex: "pair-index",
	Postcode: "postcode",
	Gazetteer: "gazetteer",
	ORTWASM: "ort-wasm",
	SQLiteWASM: "sqlite-wasm",
	Manifest: "manifest",
	Other: "other",
} as const

export type ArtifactRole = (typeof ArtifactRole)[keyof typeof ArtifactRole]

/**
 * The words a page shows for each {@linkcode ArtifactRole}.
 */
export const ARTIFACT_ROLE_LABELS: Readonly<Record<ArtifactRole, string>> = {
	weights: "Model weights",
	embeddings: "Embeddings",
	tokenizer: "Tokenizer",
	lexicon: "Vocabulary and lexicons",
	"model-card": "Model card",
	calibration: "Calibration table",
	fst: "FST gazetteer",
	"pair-index": "Placetype-pair index",
	postcode: "Postcode index",
	gazetteer: "Gazetteer database",
	"ort-wasm": "ONNX runtime (WebAssembly)",
	"sqlite-wasm": "SQLite runtime (WebAssembly)",
	manifest: "Manifest",
	other: "Other file",
}

/**
 * Where an artifact's bytes came from.
 *
 * `unknown` means the browser gave no evidence either way, as for a cross-origin
 * response without timing headers.
 */
export type ArtifactSource = "service-worker" | "http-cache" | "network" | "unknown"

/**
 * The response header a caching service worker adds, with the value `service-worker`,
 * to an answer it read from Cache Storage.
 */
export const SERVED_FROM_HEADER = "x-mw-served-from"

/**
 * - `loading`: the request is in flight.
 * - `done`: the artifact arrived.
 * - `missing`: the server answered 404.
 *   An optional artifact, such as `calibration.json`, may be absent.
 * - `failed`: the request or the artifact's use failed, and `error` holds the reason.
 */
export type ArtifactState = "loading" | "done" | "missing" | "failed"

export interface LedgerEntry {
	role: ArtifactRole
	url: string
	/**
	 * The body bytes received so far.
	 */
	received: number
	/**
	 * The body length the response declared, or `null` when it declared none.
	 */
	total: number | null
	/**
	 * Where the bytes came from, `null` until the artifact settles.
	 */
	source: ArtifactSource | null
	state: ArtifactState
	error: string | null
}

export interface LoadLedgerSnapshot {
	/**
	 * One entry per artifact, in the order its request started.
	 */
	entries: readonly LedgerEntry[]
	/**
	 * The number of requests waiting for the browser to report a network connection.
	 */
	waitingForNetwork: number
}
