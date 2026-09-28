/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default street-name evidence index for the user-facing parse surfaces: the rerank is
 *   positive-evidence-only, so it can add an atlas-confirmed street but never remove a model call.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { StreetLocalityEvidence } from "@mailwoman/resolver"
import { resolvePath } from "path-ts"

let cached: Promise<StreetLocalityEvidence | null> | null = null

/**
 * Lazy-load and cache the bundled FR street-name index.
 *
 * @returns `null` when `@mailwoman/resolver-wof-sqlite` or `street-centroids-fr.db`
 * cannot be resolved, so the pipeline performs no rerank instead of throwing.
 */
export function loadDefaultStreetEvidence(): Promise<StreetLocalityEvidence | null> {
	if (!cached) {
		cached = (async (): Promise<StreetLocalityEvidence | null> => {
			try {
				const { banDatabasePath } = await import("@mailwoman/ban/paths")
				const dbPath = banDatabasePath("street-centroids-fr.db")

				if (!(await pathExists(dbPath))) return null
				const { SQLiteStreetNameLookup } = await import("@mailwoman/resolver-wof-sqlite")

				return new SQLiteStreetNameLookup(resolvePath(dbPath))
			} catch {
				return null
			}
		})()
	}

	return cached
}
