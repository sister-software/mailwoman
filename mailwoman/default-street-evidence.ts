/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default street-name evidence index (#727 phase-4c) for the user-facing parse surfaces. When a
 *   v3+ span-head model is loaded, `createRuntimePipeline` reranks the STREET on this bundled FR index
 *   (BAN `street-centroids-fr.db`) unless the caller passes their own `streetEvidence` or opts out with
 *   `streetEvidence: false`. The rerank is positive-evidence-only — it can add an atlas-confirmed street,
 *   never remove a model call (golden-safe: 0.000 golden regression, +16.9pp FR fragment street).
 *
 *   Loaded LAZILY + cached once per process. `@mailwoman/resolver-wof-sqlite` is an OPTIONAL peer dep, so
 *   the import is dynamic — a stripped install that lacks it (or the shard) yields `null` and the pipeline
 *   runs rerank-OFF (byte-stable) instead of throwing. The SQLite handle is `readOnly` + memory-mapped, so
 *   "loading" is a cheap file-open + prepared statements, not a 563 MB read.
 */

import type { StreetLocalityEvidence } from "@mailwoman/resolver"

let cached: Promise<StreetLocalityEvidence | null> | null = null

/**
 * Lazy-load + cache the bundled FR street-name index. Returns `null` when `@mailwoman/resolver-wof-sqlite` or the
 * `street-centroids-fr.db` shard can't be resolved — the pipeline then reranks nothing (byte-stable). Cached for the
 * process lifetime (one handle, reused).
 */
export function loadDefaultStreetEvidence(): Promise<StreetLocalityEvidence | null> {
	if (!cached) {
		cached = (async (): Promise<StreetLocalityEvidence | null> => {
			try {
				const { existsSync } = await import("node:fs")
				const { dataRootPath } = await import("@mailwoman/core/utils")
				const dbPath = dataRootPath("ban", "street-centroids-fr.db")

				if (!existsSync(dbPath)) return null
				const { SQLiteStreetNameLookup } = await import("@mailwoman/resolver-wof-sqlite")

				return new SQLiteStreetNameLookup(dbPath)
			} catch {
				return null
			}
		})()
	}

	return cached
}
