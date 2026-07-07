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
 *   `place_search` ({@link buildPlaceSearchFTS} with `drop: true`) so the candidate build carries
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

import { isOfficialLanguage } from "@mailwoman/codex/country"

/**
 * Synthetic id base for GeoNames-sourced rows (#743/#193) — above Overture's 8e12 so the three sources (WOF real ids,
 * Overture, GeoNames) never collide in a combined DB.
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
 * Fold the GeoNames `P`-class places (+ their Latin alt-names) for `countries` into `db`'s `spr` / `names` /
 * `place_population` tables. Returns the total places ingested.
 *
 * `onProgress` receives one event per country (default: a stderr line, matching the build scripts' legacy output). The
 * caller MUST rebuild `place_search` afterward (`buildPlaceSearchFTS(db, { drop: true })`) for the new names to reach
 * the candidate build's alias pass.
 */
export function ingestGeonamesAliases(
	db: DatabaseSync,
	countries: string[],
	geonamesDir: string,
	onProgress?: (event: GeonamesIngestProgress) => void,
	opts?: {
		/**
		 * #267: the countries for which to ALSO fold the GeoNames A-class admin (PCLI country + ADM1 regions) and link each
		 * locality's `parent_id` + ancestry chain (locality → region → country). PER-COUNTRY because a country that already
		 * carries WOF admin would double up — pass only the ZERO-COVERAGE gap countries (the coverage-expansion targets),
		 * never the EU alias set. Without admin, a gap country's localities are orphans (`parent_id=-1`, no ancestors), so
		 * `parentID` scoping and adminCoherence can't reach them and "Tbilisi, GE" can't resolve.
		 */
		adminForCountries?: ReadonlySet<string>
		/**
		 * #936: directory of per-country alternateNamesV2 dumps
		 * (`download.geonames.org/export/dump/alternatenames/<CC>.zip` → `<CC>.txt`). When a country's file is present,
		 * alias rows gain their language tag, `privateuse` ("preferred" from `isPreferredName`), and the `official` bit
		 * (language is CLDR-official for the country, colloquial/historic excluded — the rule the #936 risk probe measured
		 * at 7 new name-exact collisions globally). The main dump's bare `alternatenames` list still decides WHICH rows
		 * exist; V2 only decorates them. Missing file = the pre-#936 untagged behavior, not an error.
		 */
		alternateDir?: string
	}
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
		`INSERT INTO names (id, name, placetype, country, language, privateuse, official, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const populationInsert = db.prepare(`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`)
	// #267 admin linkage: ancestor rows (locality→region→country) so parentID scoping + adminCoherence reach
	// the gap countries. Only used for a country in opts.adminForCountries.
	const ancestorInsert = db.prepare(
		`INSERT INTO ancestors (id, ancestor_id, ancestor_placetype, lastmodified) VALUES (?, ?, ?, 0)`
	)

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
		// #267: add A-class admin + ancestry only for the gap countries this country is in (never the EU set).
		const addAdmin = opts?.adminForCountries?.has(cc) ?? false
		// GeoNames dump columns (0-indexed): 0 geonameid, 1 name, 2 asciiname, 3 alternatenames, 4 lat, 5 lon,
		// 6 feature_class, 7 feature_code, 10 admin1 code, 14 pop.
		const lines = readFileSync(file, "utf8").split("\n")

		// #936: V2 tags for this country's P-class rows — geonameid → exact alias spelling → tag. The V2
		// dump repeats one spelling under several languages ("Åbo" sv/da/no); the merged tag is official /
		// preferred if ANY qualifying row is.
		const v2File = opts?.alternateDir ? join(opts.alternateDir, `${cc}.txt`) : undefined
		let v2: Map<number, Map<string, { language: string; privateuse: string; official: number }>> | undefined

		if (v2File && existsSync(v2File)) {
			const wanted = new Set<number>()

			for (const line of lines) {
				const f = line.split("\t")

				if (f[6] === "P") {
					wanted.add(Number(f[0]))
				}
			}
			v2 = new Map()

			// V2 columns (0-indexed): 1 geonameid, 2 isolanguage, 3 name, 4 isPreferredName, 5 isShortName,
			// 6 isColloquial, 7 isHistoric, 8 from, 9 to.
			//
			// Two passes, because historic-ness is a fact about the NAME, not the row: GeoNames splits one
			// spelling across rows — Malabo carries "Santa Isabel" as (es, unflagged) AND as (no-language,
			// isHistoric=1, to=1973). Officialness must see the flags from EVERY row for the spelling, or the
			// colonial-era name sails through on the language-tagged row (the #936 review's Malabo finding).
			// Do NOT gate on isPreferredName instead — it's sparse annotation, not a signal (Turku's sv "Åbo"
			// is unflagged; FI has 1,746 flags across the whole dump).
			const v2Lines = readFileSync(v2File, "utf8").split("\n")
			const historicNames = new Set<string>()

			for (const line of v2Lines) {
				if (!line) continue
				const f = line.split("\t")

				if (f[6] === "1" || f[7] === "1" || (f[9] ?? "").trim() !== "") {
					const alt = (f[3] ?? "").trim()

					if (alt && wanted.has(Number(f[1]))) {
						historicNames.add(`${f[1]}|${alt}`)
					}
				}
			}

			for (const line of v2Lines) {
				if (!line) continue
				const f = line.split("\t")
				const gid = Number(f[1])

				if (!wanted.has(gid)) continue
				const lang = f[2] ?? ""

				// ISO 639 codes are 2-3 letters; GeoNames' pseudo-codes (post, link, iata, wkdt, …) are 4+.
				if (!/^[a-z]{2,3}$/.test(lang)) continue
				const alt = (f[3] ?? "").trim()

				if (!alt) continue
				const preferred = f[4] === "1"
				const official = !historicNames.has(`${gid}|${alt}`) && isOfficialLanguage(cc, lang) ? 1 : 0
				let byName = v2.get(gid)

				if (!byName) {
					v2.set(gid, (byName = new Map()))
				}
				const prev = byName.get(alt)

				if (!prev) {
					byName.set(alt, { language: lang, privateuse: preferred ? "preferred" : "", official })
				} else {
					if (official && !prev.official) {
						prev.language = lang
						prev.official = 1
					}

					if (preferred && !prev.privateuse) {
						prev.privateuse = "preferred"
					}
				}
			}
		}

		// #267 admin pre-pass (gap countries): fold the country (PCLI) + regions (ADM1), self+ancestry them, and
		// build the admin1→region map the localities link through. Point bbox (GeoNames gives a centroid only).
		let countryID = -1
		const adminMap = new Map<string, number>()

		if (addAdmin) {
			for (const line of lines) {
				const f = line.split("\t")

				if (f[6] !== "A") continue
				const aname = clean(f[2] ?? "") ?? clean(f[1] ?? "")

				if (!aname) continue
				const lat = Number(f[4]) || 0
				const lon = Number(f[5]) || 0

				if (f[7]?.startsWith("PCL")) {
					// Any country-level political entity — PCLI (independent), PCLD (dependent territory),
					// PCLF (freely associated), PCLS (special administrative region: HK/MO/PS). All are the
					// country tier; restricting to PCLI left those ~17 territories without a country row.
					if (countryID >= 0) continue // one country row
					countryID = id++
					sprInsert.run(countryID, -1, aname, "country", cc, lat, lon, lat, lon, lat, lon, 1, 0, 0, 0, 0, 0)
					namesInsert.run(countryID, aname, "country", cc, "", "", 0, 0)
					ancestorInsert.run(countryID, countryID, "country")
				} else if (f[7] === "ADM1" && f[10]) {
					const rid = id++
					sprInsert.run(rid, -1, aname, "region", cc, lat, lon, lat, lon, lat, lon, 1, 0, 0, 0, 0, 0)
					namesInsert.run(rid, aname, "region", cc, "", "", 0, 0)
					ancestorInsert.run(rid, rid, "region")
					adminMap.set(f[10], rid)
				}
			}

			// Re-parent regions + ancestor them to the (now-known) country.
			if (countryID >= 0) {
				for (const rid of adminMap.values()) {
					db.prepare("UPDATE spr SET parent_id = ? WHERE id = ?").run(countryID, rid)
					ancestorInsert.run(rid, countryID, "country")
				}
			}
		}

		for (const line of lines) {
			if (!line) continue
			const f = line.split("\t")

			if (f[6] !== "P") continue // populated places only
			const lat = Number(f[4])
			const lon = Number(f[5])

			if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
			const name = clean(f[1] ?? "")

			if (!name) continue
			const nid = id++
			// #267: link to the locality's region (else country) for gap countries; -1 (orphan) otherwise.
			const regionID = addAdmin ? (adminMap.get(f[10] ?? "") ?? -1) : -1
			const parentID = regionID >= 0 ? regionID : addAdmin && countryID >= 0 ? countryID : -1
			// Point bbox — a GeoNames row is a centroid; the candidate's region-bbox disambiguation just
			// sees it as contained in itself, fine for a locality.
			sprInsert.run(nid, parentID, name, "locality", cc, lat, lon, lat, lon, lat, lon, 1, 0, 0, 0, 0, 0)
			namesInsert.run(nid, name, "locality", cc, "", "", 0, 0)

			if (addAdmin) {
				ancestorInsert.run(nid, nid, "locality")

				if (regionID >= 0) {
					ancestorInsert.run(nid, regionID, "region")
				}

				if (countryID >= 0) {
					ancestorInsert.run(nid, countryID, "country")
				}
			}
			const seen = new Set([name])

			const tags = v2?.get(Number(f[0]))

			for (const raw of [f[2] ?? "", ...(f[3] ? f[3].split(",") : [])]) {
				const alt = clean(raw)

				if (alt && !seen.has(alt)) {
					seen.add(alt)
					const tag = tags?.get(alt)

					namesInsert.run(nid, alt, "locality", cc, tag?.language ?? "", tag?.privateuse ?? "", tag?.official ?? 0, 0)
				}
			}
			const pop = Number(f[14]) || 0

			if (pop > 0) {
				populationInsert.run(nid, pop)
			}
			nc++
		}
		report({ country: cc, places: nc, skipped: false })
		total += nc
	}
	db.exec("COMMIT")

	return total
}
