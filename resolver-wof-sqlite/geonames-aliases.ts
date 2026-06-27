/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #743/#193 — fold GeoNames bilingual / alt-language place-names into a WOF/unified admin DB as
 *   first-class places. The hard-filter recall gap on bilingual countries (the address says
 *   "Karjaa" but the table holds the Swedish "Karis") is missing alt-LANGUAGE names, not missing
 *   places: the WOF/Overture `names` carried only the primary, so the candidate build's Latin-alias
 *   explode (build-candidate pass 2) had nothing to widen. GeoNames' per-country dump carries the
 *   variants inline (the Karis row's `alternatenames` includes "Karjaa").
 *
 *   For each POPULATED place (feature class `P`) this writes an `spr` row + `names` rows (primary +
 *   Latin alt-names) + population into the SAME tables the WOF/Overture paths use — synthetic ids
 *   based at {@link GEONAMES_ID_BASE} so the three sources never collide. The caller then rebuilds
 *   `place_search` ({@link buildPlaceSearchFts} with `drop: true`) so the candidate build carries
 *   Karjaa↔Karis. Proven (FI hard-resolve 69.5 → 85.8 %, coverage 74.4 → 94.0 %); duplicating a
 *   place already held under another source is benign — the rows share name_key+coord and the
 *   candidate ranking dedupes by score.
 *
 *   This is the package home so the canonical `build-unified-wof --geonames-countries`, the
 *   standalone `build-admin-geonames-fold` fold, AND the `mailwoman gazetteer` commands all share
 *   ONE implementation. GeoNames dump = `download.geonames.org/export/dump/<CC>.zip` → `<CC>.txt`
 *   (TSV).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"

/**
 * Synthetic id base for GeoNames-sourced rows (#743/#193) — above Overture's 8e12 so the three
 * sources (WOF real ids, Overture, GeoNames) never collide in a combined DB.
 */
export const GEONAMES_ID_BASE = 9_000_000_000_000

/** Per-country progress for the ingest — one event per country dump processed (or skipped). */
export interface GeonamesIngestProgress {
	/** ISO 3166-1 alpha-2 code. */
	country: string
	/** Populated places ingested from this country's dump (0 when skipped). */
	places: number
	/** True when the country's `<CC>.txt` dump was missing — the country is skipped, not fatal. */
	skipped: boolean
}

/**
 * Fold the GeoNames `P`-class places (+ their Latin alt-names) for `countries` into `db`'s `spr` /
 * `names` / `place_population` tables. Returns the total places ingested.
 *
 * `onProgress` receives one event per country (default: a stderr line, matching the build scripts'
 * legacy output). The caller MUST rebuild `place_search` afterward (`buildPlaceSearchFts(db, {
 * drop: true })`) for the new names to reach the candidate build's alias pass.
 */
export function ingestGeonamesAliases(
	db: DatabaseSync,
	countries: string[],
	geonamesDir: string,
	onProgress?: (event: GeonamesIngestProgress) => void
): number {
	// Latin-only, no bracket/paren noise GeoNames packs into `alternatenames` ("(( Karis Landskommun ))",
	// airport codes), 2–60 chars, at least one letter (drops bare postcodes/numbers).
	const LATIN_NAME = /^[\p{Script=Latin}\p{M}\s\-'.]{2,60}$/u
	const clean = (s: string): string | null => {
		const t = s.trim()
		return t && LATIN_NAME.test(t) && /\p{L}/u.test(t) ? t : null
	}
	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, ?, ?, ?, ?)`
	)
	const populationInsert = db.prepare(`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`)

	const report = (event: GeonamesIngestProgress, missingFile?: string): void => {
		if (onProgress) {
			onProgress(event)
		} else if (event.skipped) {
			console.error(
				`  GeoNames ${event.country}: ${missingFile} missing — download from download.geonames.org/export/dump/${event.country}.zip; skipped`
			)
		} else {
			console.error(
				`  GeoNames ${event.country}: ${event.places.toLocaleString()} populated places (+ Latin alt-names)`
			)
		}
	}

	let id = GEONAMES_ID_BASE
	let total = 0
	db.exec("BEGIN")
	for (const cc of countries) {
		const file = join(geonamesDir, `${cc}.txt`)
		if (!existsSync(file)) {
			report({ country: cc, places: 0, skipped: true }, file)
			continue
		}
		let nc = 0
		// GeoNames dump columns: 1 name, 2 asciiname, 3 alternatenames, 4 lat, 5 lon, 6 feature_class, 14 pop.
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line) continue
			const f = line.split("\t")
			if (f[6] !== "P") continue // populated places only
			const lat = Number(f[4])
			const lon = Number(f[5])
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
			const name = clean(f[1] ?? "")
			if (!name) continue
			const nid = id++
			// Point bbox — a GeoNames row is a centroid; the candidate's region-bbox disambiguation just
			// sees it as contained in itself, fine for a locality.
			sprInsert.run(nid, -1, name, "locality", cc, lat, lon, lat, lon, lat, lon, 1, 0, 0, 0, 0, 0)
			namesInsert.run(nid, name, "locality", cc, "", 0)
			const seen = new Set([name])
			for (const raw of [f[2] ?? "", ...(f[3] ? f[3].split(",") : [])]) {
				const alt = clean(raw)
				if (alt && !seen.has(alt)) {
					seen.add(alt)
					namesInsert.run(nid, alt, "locality", cc, "", 0)
				}
			}
			const pop = Number(f[14]) || 0
			if (pop > 0) populationInsert.run(nid, pop)
			nc++
		}
		report({ country: cc, places: nc, skipped: false })
		total += nc
	}
	db.exec("COMMIT")
	return total
}
