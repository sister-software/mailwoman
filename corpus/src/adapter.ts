/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adapter framework helpers — the pieces every corpus adapter and the runner share.
 *
 *   This file does **not** define `CorpusAdapter` (that lives in `./types.ts`, which is the single
 *   canonical schema module). It exposes:
 *
 *   - `AdapterRegistry`: a tiny lookup table the CLI + build pipeline use to find adapters by id.
 *   - `InMemoryAdapterRegistry`: the default implementation.
 *   - `stableSourceID(adapterID, components)`: deterministic content-addressed id for adapters whose
 *       source data has no native primary key (CSV, GeoJSON).
 *   - `HOUSE_NUMBER_PREFIX` + `splitStreetLine(line)`: the one house-number/street split every
 *       US CSV adapter uses.
 *   - `canonicalDedupKey(row)`: normalized signature used to drop near-identical rows during a run.
 *       Adapter-internal dedup; cross-adapter dedup is the runner's job.
 *   - `streamingSha256()`: thin wrapper around `node:crypto` so the runner can hash JSONL output as it
 *       streams (avoids re-reading the shard for the manifest checksum).
 *
 *   Everything here is pure (no I/O); side-effecting code goes in `./runner.ts`.
 */

import { createHash, type Hash } from "node:crypto"

import type { ComponentTag } from "@mailwoman/core/types"
import { sha256Hex } from "@mailwoman/core/utils"

import type { CanonicalRow, CorpusAdapter } from "./types.ts"

/**
 * Lookup table for corpus adapters.
 *
 * The CLI's `npx mailwoman corpus run <adapter-id>` resolves `<adapter-id>` against this registry; the same registry is
 * iterated by the `corpus build` pipeline. Adapters do not self-register at module load — they're added explicitly so
 * the dependency graph stays traceable.
 */
export interface AdapterRegistry {
	/**
	 * Add an adapter. Throws if `adapter.id` is already registered.
	 */
	register(adapter: CorpusAdapter): void

	/**
	 * Return the adapter for `id`, or `undefined`.
	 */
	get(id: string): CorpusAdapter | undefined

	/**
	 * All registered adapters, in insertion order.
	 */
	list(): readonly CorpusAdapter[]

	/**
	 * Convenience: ids only, in insertion order.
	 */
	ids(): readonly string[]
}

/**
 * Default in-memory registry. The runner constructs one per invocation; the CLI re-uses a shared singleton
 * (`defaultAdapterRegistry`) populated by `./adapters/index.ts` as adapters come online.
 */
export class InMemoryAdapterRegistry implements AdapterRegistry {
	#byID = new Map<string, CorpusAdapter>()

	register(adapter: CorpusAdapter): void {
		if (this.#byID.has(adapter.id)) {
			throw new Error(`AdapterRegistry: id ${JSON.stringify(adapter.id)} already registered`)
		}

		this.#byID.set(adapter.id, adapter)
	}

	get(id: string): CorpusAdapter | undefined {
		return this.#byID.get(id)
	}

	list(): readonly CorpusAdapter[] {
		return Array.from(this.#byID.values())
	}

	ids(): readonly string[] {
		return Array.from(this.#byID.keys())
	}
}

/**
 * Process-wide default registry. Populated by `./adapters/index.ts` as adapters are built; imported by the CLI. Tests
 * should construct their own `InMemoryAdapterRegistry` to avoid cross-test pollution.
 */
export const defaultAdapterRegistry = new InMemoryAdapterRegistry()

/**
 * Deterministic content-addressed source id.
 *
 * For adapters whose upstream source has no native primary key (CSV rows, GeoJSON features), the runner expects a
 * stable id so dedup, holdout manifests, and resumability work across reruns. This helper produces one by hashing the
 * adapter id and a canonical serialization of the components dict (keys sorted, values verbatim).
 *
 * Output format: `<adapterID>-<first-12-hex-chars-of-sha256>`. 48 bits of entropy is enough for ~17M rows per adapter
 * before the expected collision count exceeds 1 (birthday paradox); adapters with more rows should extend the prefix
 * length.
 */
export function stableSourceID(adapterID: string, components: Partial<Record<ComponentTag, string>>): string {
	const sortedKeys = Object.keys(components).toSorted() as ComponentTag[]
	const payload = sortedKeys.map((k) => `${k}=${components[k] ?? ""}`).join("\u001F")
	// `update(a).update(b).update(c)` hashes the same byte stream as `update(a + b + c)`,
	// so this is the previous digest exactly — the ids stay stable across the dedupe.
	const digest = sha256Hex(`${adapterID}\u001E${payload}`)

	return `${adapterID}-${digest.slice(0, 12)}`
}

/**
 * Leading house number on a US-style street line: digits, an optional hyphenated range (Queens `40-12`), an optional
 * single alpha suffix (`101A`), then whitespace, then the rest.
 *
 * Ten CSV adapters were each carrying a byte-identical copy of this before the 2026-08-02 dedupe. It decides where the
 * house number ends and the street begins for every one of them, so it gets one definition and one set of tests — a
 * parsing edge case fixed here is fixed for all of them.
 *
 * The remainder is `(\S.*)` rather than `(.+)`, and that detail is load-bearing for a reason the ten private copies
 * never had to care about. `\s+` and `.` both match a tab, so `\s+(.+)$` lets the engine split a run of tabs between
 * the two groups every possible way before failing — quadratic backtracking, measured at 35 ms on 8k tabs and rising
 * with the square. Requiring the remainder to START with a non-space removes the overlap and makes the match linear.
 * Behaviour is unchanged: the caller trims before matching and trims group 2 after, so a remainder beginning with
 * whitespace was never observable. Verified identical over 198,549 fuzzed inputs plus the curated edge cases. (CodeQL
 * `js/polynomial-redos`, raised once this became an exported function taking library input.)
 */
export const HOUSE_NUMBER_PREFIX = /^(\d+(?:-\d+)?[A-Za-z]?)\s+(\S.*)$/

/**
 * A street line split into its house number and the remainder.
 */
export interface SplitStreetLine {
	house_number?: string
	street: string
}

/**
 * Split a US-style street line on {@link HOUSE_NUMBER_PREFIX}.
 *
 * The US CSV sources follow USPS Publication 28 conventions with hand-entry drift. The leading digit run is the house
 * number (`"123 Main St"`, `"6450 W Indian School Rd"`), and the regex tolerates one trailing letter (`"123A Main St"`)
 * plus an optional hyphenated half (`"40-12 Bell Blvd"`, common in NYC and suburban garden-apartment numbering; Hawaii
 * uses it island-wide — `"47-470 Hui Aeko Place"`).
 *
 * Returns `null` for blank input. Anything that does not match the prefix shape (`"PO Box 1234"`, `"RR 2 Box 67"`, `"HC
 * 1"`) becomes a single `street` value rather than being mangled — the model sees the original surface form and
 * downstream classifiers pick it up. Callers that need those forms recognized as something other than a street (see
 * `usgov-irs-bmf`) test for them BEFORE calling this.
 */
export function splitStreetLine(line: string): SplitStreetLine | null {
	const trimmed = line.trim()

	if (!trimmed) return null

	const match = HOUSE_NUMBER_PREFIX.exec(trimmed)

	if (match) return { house_number: match[1], street: match[2]!.trim() }

	return { street: trimmed }
}

/**
 * Canonical dedup key for a row.
 *
 * Two rows that share this key are treated as duplicates and only the first wins. The key is built from `country`, the
 * sorted `components` dict, and a normalized `raw` (lower-cased, whitespace collapsed). License and provenance fields
 * are intentionally excluded so the same address from multiple adapters is recognized as a duplicate.
 *
 * Synthetic rows are never deduplicated against natural rows: `synth.method` is folded into the key when present,
 * ensuring each augmentation variant survives.
 */
export function canonicalDedupKey(row: CanonicalRow): string {
	const sortedKeys = Object.keys(row.components).toSorted() as ComponentTag[]
	const compPart = sortedKeys.map((k) => `${k}=${row.components[k] ?? ""}`).join("\u001F")
	const rawNorm = row.raw.toLowerCase().replaceAll(/\s+/g, " ").trim()
	const synthPart = row.synth ? `\u001E${row.synth.method}` : ""

	return `${row.country}\u001E${rawNorm}\u001E${compPart}${synthPart}`
}

/**
 * Streaming SHA-256 hasher.
 *
 * The runner feeds every JSONL line into one of these so the per-shard checksum can be recorded in `MANIFEST.json`
 * without a second pass over the shard. Implementation is a one-line wrapper, but giving it a name keeps the runner's
 * hash-tracking intent obvious.
 */
export interface StreamingHasher {
	update(chunk: string | Uint8Array): void
	digest(): string
}

/**
 * Default `StreamingHasher` (SHA-256, hex).
 */
/**
 * @see {@link StreamingHasher} — this is the incremental counterpart to `sha256Hex`, not a copy of
 *   it. `@mailwoman/core/utils` exposes one-shot digests (`sha256Hex`) and whole-file digests
 *   (`sha256File`); the runner needs neither, because it hashes JSONL lines as they stream past.
 */
export function streamingSha256(): StreamingHasher {
	const h: Hash = createHash("sha256")
	let finalized = false
	let digestHex = ""

	return {
		update(chunk) {
			if (finalized) throw new Error("streamingSha256: update() called after digest()")
			h.update(typeof chunk === "string" ? chunk : chunk)
		},
		digest() {
			if (!finalized) {
				digestHex = h.digest("hex")
				finalized = true
			}

			return digestHex
		},
	}
}
