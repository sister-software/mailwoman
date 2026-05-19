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
 *   - `stableSourceId(adapterId, components)`: deterministic content-addressed id for adapters whose
 *       source data has no native primary key (CSV, GeoJSON).
 *   - `canonicalDedupKey(row)`: normalized signature used to drop near-identical rows during a run.
 *       Adapter-internal dedup; cross-adapter dedup is the runner's job.
 *   - `streamingSha256()`: thin wrapper around `node:crypto` so the runner can hash JSONL output as it
 *       streams (avoids re-reading the shard for the manifest checksum).
 *
 *   Everything here is pure (no I/O); side-effecting code goes in `./runner.ts`.
 */

import type { ComponentTag } from "@mailwoman/core/types"
import { createHash, type Hash } from "node:crypto"
import type { CanonicalRow, CorpusAdapter } from "./types.js"

/**
 * Lookup table for corpus adapters.
 *
 * The CLI's `npx mailwoman corpus run <adapter-id>` resolves `<adapter-id>` against this registry;
 * the same registry is iterated by the `corpus build` pipeline. Adapters do not self-register at
 * module load — they're added explicitly so the dependency graph stays traceable.
 */
export interface AdapterRegistry {
	/** Add an adapter. Throws if `adapter.id` is already registered. */
	register(adapter: CorpusAdapter): void

	/** Return the adapter for `id`, or `undefined`. */
	get(id: string): CorpusAdapter | undefined

	/** All registered adapters, in insertion order. */
	list(): readonly CorpusAdapter[]

	/** Convenience: ids only, in insertion order. */
	ids(): readonly string[]
}

/**
 * Default in-memory registry. The runner constructs one per invocation; the CLI re-uses a shared
 * singleton (`defaultAdapterRegistry`) populated by `./adapters/index.ts` as adapters come online.
 */
export class InMemoryAdapterRegistry implements AdapterRegistry {
	#byId = new Map<string, CorpusAdapter>()

	register(adapter: CorpusAdapter): void {
		if (this.#byId.has(adapter.id)) {
			throw new Error(`AdapterRegistry: id ${JSON.stringify(adapter.id)} already registered`)
		}
		this.#byId.set(adapter.id, adapter)
	}

	get(id: string): CorpusAdapter | undefined {
		return this.#byId.get(id)
	}

	list(): readonly CorpusAdapter[] {
		return Array.from(this.#byId.values())
	}

	ids(): readonly string[] {
		return Array.from(this.#byId.keys())
	}
}

/**
 * Process-wide default registry. Populated by `./adapters/index.ts` as adapters are built; imported
 * by the CLI. Tests should construct their own `InMemoryAdapterRegistry` to avoid cross-test
 * pollution.
 */
export const defaultAdapterRegistry = new InMemoryAdapterRegistry()

/**
 * Deterministic content-addressed source id.
 *
 * For adapters whose upstream source has no native primary key (CSV rows, GeoJSON features), the
 * runner expects a stable id so dedup, holdout manifests, and resumability work across reruns. This
 * helper produces one by hashing the adapter id and a canonical serialization of the components
 * dict (keys sorted, values verbatim).
 *
 * Output format: `<adapterId>-<first-12-hex-chars-of-sha256>`. 48 bits of entropy is enough for
 * ~17M rows per adapter before the expected collision count exceeds 1 (birthday paradox); adapters
 * with more rows should extend the prefix length.
 */
export function stableSourceId(adapterId: string, components: Partial<Record<ComponentTag, string>>): string {
	const sortedKeys = Object.keys(components).sort() as ComponentTag[]
	const payload = sortedKeys.map((k) => `${k}=${components[k] ?? ""}`).join("\x1f")
	const digest = createHash("sha256").update(adapterId).update("\x1e").update(payload).digest("hex")
	return `${adapterId}-${digest.slice(0, 12)}`
}

/**
 * Canonical dedup key for a row.
 *
 * Two rows that share this key are treated as duplicates and only the first wins. The key is built
 * from `country`, the sorted `components` dict, and a normalized `raw` (lower-cased, whitespace
 * collapsed). License and provenance fields are intentionally excluded so the same address from
 * multiple adapters is recognized as a duplicate.
 *
 * Synthetic rows are never deduplicated against natural rows: `synth.method` is folded into the key
 * when present, ensuring each augmentation variant survives.
 */
export function canonicalDedupKey(row: CanonicalRow): string {
	const sortedKeys = Object.keys(row.components).sort() as ComponentTag[]
	const compPart = sortedKeys.map((k) => `${k}=${row.components[k] ?? ""}`).join("\x1f")
	const rawNorm = row.raw.toLowerCase().replace(/\s+/g, " ").trim()
	const synthPart = row.synth ? `\x1e${row.synth.method}` : ""
	return `${row.country}\x1e${rawNorm}\x1e${compPart}${synthPart}`
}

/**
 * Streaming SHA-256 hasher.
 *
 * The runner feeds every JSONL line into one of these so the per-shard checksum can be recorded in
 * `MANIFEST.json` without a second pass over the shard. Implementation is a one-line wrapper, but
 * giving it a name keeps the runner's hash-tracking intent obvious.
 */
export interface StreamingHasher {
	update(chunk: string | Uint8Array): void
	digest(): string
}

/** Default `StreamingHasher` (SHA-256, hex). */
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
