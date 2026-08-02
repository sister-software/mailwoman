/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The content key for the derived-weights store at `$MAILWOMAN_DATA_ROOT/derived/weights/<key>`.
 *
 *   WHY A LOCAL STORE: the `weights-*` actions/cache entry carried 76.3 MB of real files and took
 *   48–54s to restore on the two `mailwoman-data` legs — about 1.6 MB/s over the lab's degraded path
 *   to GitHub's cache service — to a host that already has the source model on local disk
 *   (`release.config.json` → `dataRoot`). Only `postcode-<cc>.bin` and `pair-index-<cc>.bin` are
 *   expensive to produce, so those are what the store holds. The runners are self-hosted, so the
 *   filesystem persists across runs and the store is durable.
 *
 *   WHY THE GENERATORS ARE HASHED: on 2026-08-02 the workflow key hashed `release.config.json` and
 *   `data/gazetteer/*` but not the extractor, so a currency-filter change produced new artifacts
 *   while the cache served old ones and the pair-index↔card parity guard failed with
 *   `expected 47878 to be 49033`. The generating code is part of the input, not context around it.
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

/**
 * Repo-relative files the derived binaries are a function of, beyond the `data/gazetteer` payload enumerated by
 * {@link derivedWeightsInputPaths}.
 *
 * The first entry mirrors the retired workflow cache key. The rest are what that key MISSED: the modules that generate
 * the binaries. Add here whenever a new input starts feeding the build — a key that omits an input serves stale
 * artifacts silently, which is the failure this list exists to prevent.
 */
export const DERIVED_WEIGHTS_INPUTS: readonly string[] = [
	"release.config.json",
	"mailwoman/gazetteer-pipeline/borough-pairs.ts",
	"mailwoman/gazetteer-pipeline/lieudit-pairs.ts",
	"mailwoman/commands/gazetteer/pair-index.tsx",
	"mailwoman/commands/gazetteer/postcode-binary.tsx",
]

/**
 * The `data/gazetteer` payload, matched the way the retired workflow key matched it (`*.json` + `*.jsonl`). Enumerated
 * rather than hardcoded so a new shard is picked up without a code change — the opposite trade from
 * {@link DERIVED_WEIGHTS_INPUTS}, where an explicit list is the point.
 */
function gazetteerDataPaths(): string[] {
	const dir = resolve(repoRootPath(), "data", "gazetteer")

	if (!existsSync(dir)) return []

	return readdirSync(dir)
		.filter((name) => name.endsWith(".json") || name.endsWith(".jsonl"))
		.map((name) => join(dir, name))
}

/**
 * Every absolute path this checkout's key is computed over.
 */
export function derivedWeightsInputPaths(): string[] {
	return [...DERIVED_WEIGHTS_INPUTS.map((p) => resolve(repoRootPath(), p)), ...gazetteerDataPaths()]
}

/**
 * Hash an explicit list of absolute paths. Exported for testing; production callers want {@link derivedWeightsKey}.
 *
 * Sorted, so the caller's ordering cannot change the key. Each path contributes its own name as well as its bytes, so
 * moving an input is a change. A missing path contributes a `\0absent` marker rather than nothing — "the file is gone"
 * and "the file is empty" must not collide.
 */
export function derivedWeightsKeyFrom(paths: readonly string[]): string {
	const hash = createHash("sha256")

	for (const path of paths.toSorted()) {
		hash.update(path)
		hash.update("\0")

		try {
			statSync(path)
			hash.update(readFileSync(path))
		} catch {
			hash.update("\0absent")
		}

		hash.update("\0")
	}

	return hash.digest("hex").slice(0, 16)
}

/**
 * The key for this checkout's derived weights.
 */
export function derivedWeightsKey(): string {
	return derivedWeightsKeyFrom(derivedWeightsInputPaths())
}

/**
 * Where the derived binaries for `key` live.
 */
export function derivedWeightsDir(key: string): string {
	return String(dataRootPath("derived", "weights", key))
}
