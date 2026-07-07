/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FTS step of the gazetteer pipeline — `place_search` (FTS5) + `place_bbox` (R*Tree, the reverse
 *   geocoder's candidate index). A thin wrapper over the canonical
 *   `@mailwoman/resolver-wof-sqlite/fts` builder so the pipeline's phases share one signature shape.
 *   MUST run AFTER `enrichAdmin` — `place_search` concatenates the `names` rows, abbreviations included.
 */

import type { DatabaseSync } from "node:sqlite"

export interface BuildFTSOptions {
	/** Drop + rebuild existing FTS/bbox tables (a staging DB from a prior partial run). Default false. */
	drop?: boolean
	onProgress?: (phase: string, detail?: string) => void
}

export interface BuildFTSResult {
	ftsRows: number
	bboxRows: number
}

/** Build `place_search` + `place_bbox` on an open (unsealed) admin DB. */
export async function buildFTS(db: DatabaseSync, opts: BuildFTSOptions = {}): Promise<BuildFTSResult> {
	// resolver-wof-sqlite is an OPTIONAL peer of mailwoman — lazy import (the gazetteer-pipeline convention).
	const { buildPlaceSearchFTS } = await import("@mailwoman/resolver-wof-sqlite/fts")
	const result = buildPlaceSearchFTS(db, {
		drop: opts.drop ?? false,
		onProgress: (phase, detail) => opts.onProgress?.(phase, detail),
	})

	return { ftsRows: result.indexedRows, bboxRows: result.bboxIndexedRows }
}
