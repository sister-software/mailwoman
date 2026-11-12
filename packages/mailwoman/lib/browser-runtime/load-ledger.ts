// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The load ledger: a record of each artifact one release load requests, kept current
 *   while the load runs so a page can show what is downloading and what failed.
 */

import {
	ArtifactRole,
	type ArtifactSource,
	type LedgerEntry,
	type LoadLedgerSnapshot,
	SERVED_FROM_HEADER,
} from "@mailwoman/core/load-ledger"

import { type BytesReceived, fetchWithRetry, requestURL, subscribeNetworkWaits } from "#browser-runtime/fetch"

/**
 * The shortest interval between two byte-count notifications, so a large download
 * doesn't re-render a page once per network chunk.
 */
const BYTE_NOTIFY_INTERVAL_MS = 100

/**
 * The HTTP status an absent optional artifact answers with, such as a release without `calibration.json`.
 */
const HTTP_NOT_FOUND = 404

/**
 * The role of an artifact, read from its URL's file name.
 *
 * The names are the ones the release publisher writes, such as `model.onnx`,
 * `embeddings-hot.bin` and `pair-index-gb.bin`.
 */
export function roleOfArtifactURL(url: string): ArtifactRole {
	const path = new URL(url, "https://mailwoman.invalid/").pathname
	const file = path.slice(path.lastIndexOf("/") + 1)

	if (file.endsWith(".onnx")) return ArtifactRole.Weights

	if (file.startsWith("embeddings")) return ArtifactRole.Embeddings

	if (file === "tokenizer.model") return ArtifactRole.Tokenizer

	if (file === "char-vocab.json" || file.includes("lexicon")) return ArtifactRole.Lexicon

	if (file === "model-card.json") return ArtifactRole.ModelCard

	if (file === "calibration.json") return ArtifactRole.Calibration

	if (file.startsWith("fst-")) return ArtifactRole.FST

	if (path.includes("/pair-index/")) return ArtifactRole.PairIndex

	if (file.startsWith("postcode")) return ArtifactRole.Postcode

	if (file.endsWith(".db")) return ArtifactRole.Gazetteer

	if (file.endsWith(".wasm")) return file.includes("sqlite") ? ArtifactRole.SQLiteWASM : ArtifactRole.ORTWASM

	if (file.endsWith(".json")) return ArtifactRole.Manifest

	return ArtifactRole.Other
}

/**
 * The fields of a resource-timing entry this module reads.
 *
 * This library compiles without the DOM types.
 */
interface ResourceTimingLike {
	transferSize?: number
	deliveryType?: string
}

/**
 * Where a settled response's bytes came from.
 *
 * The service worker's header marks a Cache Storage answer.
 * Otherwise the browser's resource timing decides: `deliveryType: "cache"` is the
 * HTTP cache, and a nonzero `transferSize` is the network.
 *
 * A cross-origin response without `Timing-Allow-Origin` reports neither, and reads as `unknown`.
 */
export function artifactSource(url: string, response: Response): ArtifactSource {
	if (response.headers.get(SERVED_FROM_HEADER) === "service-worker") return "service-worker"

	const performance = (globalThis as { performance?: { getEntriesByName?: (name: string) => unknown[] } }).performance

	const entry = performance?.getEntriesByName?.(url).at(-1) as ResourceTimingLike | undefined

	if (entry?.deliveryType === "cache") return "http-cache"

	if (typeof entry?.transferSize === "number" && entry.transferSize > 0) return "network"

	return "unknown"
}

/**
 * The mutable record behind a {@link LoadLedgerSnapshot}.
 *
 * `onChange` receives a new snapshot after each change.
 * Byte counts are throttled to one notification per {@link BYTE_NOTIFY_INTERVAL_MS}.
 */
export class LoadLedger {
	readonly #entries = new Map<string, LedgerEntry>()
	readonly #onChange: (snapshot: LoadLedgerSnapshot) => void
	#waitingForNetwork = 0
	#lastByteNotify = 0

	constructor(onChange: (snapshot: LoadLedgerSnapshot) => void) {
		this.#onChange = onChange
	}

	snapshot(): LoadLedgerSnapshot {
		return { entries: [...this.#entries.values()], waitingForNetwork: this.#waitingForNetwork }
	}

	/**
	 * The entries whose state is `failed`, in request order.
	 */
	failures(): LedgerEntry[] {
		return [...this.#entries.values()].filter((entry) => entry.state === "failed")
	}

	start(url: string, role: ArtifactRole = roleOfArtifactURL(url)): void {
		this.#entries.set(url, { role, url, received: 0, total: null, source: null, state: "loading", error: null })
		this.#notify()
	}

	bytes(url: string, received: number, total: number | null): void {
		const entry = this.#entries.get(url)

		if (!entry) return

		this.#entries.set(url, { ...entry, received, total })

		const now = Date.now()

		if (now - this.#lastByteNotify >= BYTE_NOTIFY_INTERVAL_MS) {
			this.#lastByteNotify = now
			this.#notify()
		}
	}

	settle(url: string, update: Pick<LedgerEntry, "state" | "source" | "error">): void {
		const entry = this.#entries.get(url)

		if (!entry) return

		this.#entries.set(url, { ...entry, ...update })
		this.#notify()
	}

	setWaitingForNetwork(waiting: number): void {
		if (waiting === this.#waitingForNetwork) return

		this.#waitingForNetwork = waiting
		this.#notify()
	}

	#notify(): void {
		this.#onChange(this.snapshot())
	}
}

/**
 * The signature of {@linkcode fetchWithRetry}, which the ledger fetch wraps.
 */
type RetryingFetch = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
	onBytes?: BytesReceived
) => Promise<Response>

/**
 * A `fetch` that records each request in `ledger`.
 *
 * `onBytes`, when given, also receives each request's byte counts with its URL.
 */
export function ledgerFetch(
	ledger: LoadLedger,
	options: { fetchImpl?: RetryingFetch; onBytes?: (url: string, received: number, total: number | null) => void } = {}
): typeof fetch {
	const fetchImpl = options.fetchImpl ?? fetchWithRetry

	return async (input, init) => {
		const url = requestURL(input)

		ledger.start(url)

		try {
			const response = await fetchImpl(input, init, (received, total) => {
				ledger.bytes(url, received, total)
				options.onBytes?.(url, received, total)
			})

			const source = artifactSource(url, response)

			if (response.ok) {
				ledger.settle(url, { state: "done", source, error: null })
			} else if (response.status === HTTP_NOT_FOUND) {
				ledger.settle(url, { state: "missing", source, error: null })
			} else {
				ledger.settle(url, { state: "failed", source, error: `HTTP ${response.status}` })
			}

			return response
		} catch (error) {
			ledger.settle(url, {
				state: "failed",
				source: null,
				error: error instanceof Error ? error.message : String(error),
			})

			throw error
		}
	}
}

/**
 * Starts copying the count of requests waiting for a connection into `ledger`,
 * and returns the stop function.
 */
export function followNetworkWaits(ledger: LoadLedger): () => void {
	return subscribeNetworkWaits((waiting) => ledger.setWaitingForNetwork(waiting))
}

/**
 * A release load that failed, with the failed artifact when the ledger recorded one.
 */
export class ArtifactLoadError extends Error {
	readonly artifact: LedgerEntry | null

	constructor(artifact: LedgerEntry | null, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause)
		const file = artifact ? artifact.url.slice(artifact.url.lastIndexOf("/") + 1) : null

		super(file ? `Couldn't load ${file} (${artifact?.role}): ${artifact?.error ?? reason}` : reason, { cause })
		this.name = "ArtifactLoadError"
		this.artifact = artifact
	}
}
