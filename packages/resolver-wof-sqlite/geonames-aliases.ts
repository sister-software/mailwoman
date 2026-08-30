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
 *   pipeline fold (`gazetteer-pipeline/admin/fold-geonames`), AND the `mailwoman gazetteer` commands all share
 *   ONE implementation. GeoNames dump = `download.geonames.org/export/dump/<CC>.zip` → `<CC>.txt`
 *   (TSV).
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { pathExists } from "@mailwoman/core/fs/readers"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"
import { TSVSpliterator } from "spliterator"

import { GEONAMES_POSTAL_ID_BASE } from "./geonames-postal.ts"
import type { WOFDatabase } from "./schema.ts"

/**
 * Synthetic id base for GeoNames-sourced rows (#743/#193) — above Overture's 8e12 so the three sources (WOF real ids,
 * Overture, GeoNames) never collide in a combined DB.
 */
export const GEONAMES_ID_BASE = 9_000_000_000_000

/**
 * The four tables the alias fold writes into the range it owns. The purge and the ingest must agree on this list — a
 * table written but not purged is exactly the #1514 defect.
 */
const FOLD_OWNED_TABLES = ["spr", "names", "place_population", "ancestors"] as const

/**
 * Clear everything the alias fold owns — `[GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE)` across {@link
 * FOLD_OWNED_TABLES}
 * — so a fold's output is a function of its country list and dumps ALONE, never of what the DB happened to hold first.
 * Returns the rows removed per table.
 *
 * This exists because the synthetic id is a POSITION (`GEONAMES_ID_BASE + n`, counted across the country list in
 * order), not a derivation from the geonameid: change the list, its order, or a dump's contents and every subsequent id
 * shifts. Without the purge, a second fold overwrote the `spr` PREFIX it reached (`INSERT OR REPLACE`) while its
 * `names`/`ancestors` rows merely appended (bare `INSERT`) and `place_population` skipped unpopulated places entirely —
 * so the previous run's names, ancestry and populations stayed bound to ids now describing other places.
 *
 * Measured on the live 2026-08-05 artifact: a 14-country re-fold over the 161-country fold baked into
 * `admin-global-priority.db` put 522,184 of 2,110,096 name rows in the range (24.7 %) on a place from a different
 * country. Gaborone/BW at id 9000000121151 became Aichegg/AT and kept all 26 of its names; Kinshasa's 16,000,000
 * population landed on a Lithuanian hamlet.
 *
 * The upper bound is NOT the end of the id space. Each later shard owns a range above this one — GeoNames-postal @
 * 9.5e12, NL-PC6 @ 9.6e12, Code-Point @ 9.7e12, NI @ 9.8e12 — and a purge that ran past {@link GEONAMES_POSTAL_ID_BASE}
 * would delete them.
 */
export function purgeGeonamesAliasRange<DB>(db: DatabaseClient<DB>): Record<string, number> {
	const removed: Record<string, number> = {}

	for (const table of FOLD_OWNED_TABLES) {
		const result = db
			.prepare(`DELETE FROM ${table} WHERE id >= ? AND id < ?`)
			.run(GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE)

		removed[table] = Number(result.changes)
	}

	return removed
}

/**
 * Per-country progress for the ingest — one event per country dump processed (or skipped).
 */
export interface GeonamesIngestProgress {
	/**
	 * ISO 3166-1 alpha-2 code.
	 */
	country: string
	/**
	 * Populated places ingested from this country's dump (0 when skipped).
	 */
	places: number
	/**
	 * True when the country's `<CC>.txt` dump was missing — the country is skipped, not fatal.
	 */
	skipped: boolean
}

/**
 * One spelling's language attribution, as reconciled across every alternate-names row that carries it.
 */
interface V2Alias {
	language: string
	privateuse: string
	official: number
}

/**
 * Parse a country's alternateNamesV2 file into `geonameid -> spelling -> attribution`, restricted to the populated
 * places (`P`) in `wanted`.
 */
async function parseAlternateNamesV2(
	v2File: string,
	cc: string,
	wanted: ReadonlySet<number>
): Promise<Map<number, Map<string, V2Alias>>> {
	const v2 = new Map<number, Map<string, V2Alias>>()

	// V2 columns (0-indexed): 1 geonameid, 2 isolanguage, 3 name, 4 isPreferredName, 5 isShortName,
	// 6 isColloquial, 7 isHistoric, 8 from, 9 to.
	//
	// Two passes, because historic-ness is a fact about the NAME, not the row: GeoNames splits one
	// spelling across rows — Malabo carries "Santa Isabel" as (es, unflagged) AND as (no-language,
	// isHistoric=1, to=1973). Officialness must see the flags from EVERY row for the spelling, or the
	// colonial-era name sails through on the language-tagged row (the #936 review's Malabo finding).
	// Do NOT gate on isPreferredName instead — it's sparse annotation, not a signal (Turku's sv "Åbo"
	// is unflagged; FI has 1,746 flags across the whole dump).
	//
	// Both passes STREAM the file rather than sharing one materialized array: NO's V2 dump is 33 MB,
	// and a second read off the page cache costs less than holding half a million line strings.
	// `header: false` — the dump is headerless.
	const historicNames = new Set<string>()

	for await (const f of TSVSpliterator.fromAsync(v2File, { header: false })) {
		if (f[6] === "1" || f[7] === "1" || (f[9] ?? "").trim() !== "") {
			const alt = (f[3] ?? "").trim()

			if (alt && wanted.has(Number(f[1]))) {
				historicNames.add(`${f[1]}|${alt}`)
			}
		}
	}

	for await (const f of TSVSpliterator.fromAsync(v2File, { header: false })) {
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

	return v2
}

/**
 * Fold the GeoNames `P`-class places (+ their Latin alt-names) for `countries` into `db`'s `spr` / `names` /
 * `place_population` tables. Returns the total places ingested.
 *
 * `onProgress` receives one event per country (default: a stderr line, matching the build scripts' legacy output). The
 * caller MUST rebuild `place_search` afterward (`buildPlaceSearchFTS(db, { drop: true })`) for the new names to reach
 * the candidate build's alias pass.
 */
export async function ingestGeonamesAliases(
	db: DatabaseClient<WOFDatabase>,
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
): Promise<number> {
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

	// #1514: clear the range before writing it. Inside the transaction, so a fold that throws leaves the
	// DB as it found it rather than half-purged. See purgeGeonamesAliasRange for why the ids demand this.
	purgeGeonamesAliasRange(db)

	for (const cc of countries) {
		const file = join(geonamesDir, `${cc}.txt`)

		if (!(await pathExists(file))) {
			report({ country: cc, places: 0, skipped: true }, file)

			continue
		}

		let nc = 0
		// #267: add A-class admin + ancestry only for the gap countries this country is in (never the EU set).
		const addAdmin = opts?.adminForCountries?.has(cc) ?? false
		const v2File = opts?.alternateDir ? join(opts.alternateDir, `${cc}.txt`) : undefined
		const readV2 = Boolean(v2File && (await pathExists(v2File)))

		// Survey pass. The dump is STREAMED — NO's is 71 MB and only the caller knows which country
		// comes next — so what a later pass needs has to be collected here rather than re-scanned off a
		// materialized array. Two things qualify, and both are small: the P-class geonameid set the V2
		// decoration is restricted to, and the handful of A-class rows the admin pre-pass writes (one
		// PCL* + the ADM1s). Everything else is re-read in the emit pass below. Neither is wanted
		// without V2 tags or admin, and then the pass is skipped rather than read for nothing.
		//
		// GeoNames dump columns (0-indexed): 0 geonameid, 1 name, 2 asciiname, 3 alternatenames, 4 lat, 5 lon,
		// 6 feature_class, 7 feature_code, 10 admin1 code, 14 pop.
		//
		// `header: false` — the dump is headerless, so row 1 is a place, not column names.
		const wanted = new Set<number>()
		const adminRows: string[][] = []

		if (readV2 || addAdmin) {
			for await (const f of TSVSpliterator.fromAsync(file, { header: false })) {
				if (f[6] === "P") {
					if (readV2) {
						wanted.add(Number(f[0]))
					}

					continue
				}

				if (addAdmin && f[6] === "A" && (f[7]?.startsWith("PCL") || (f[7] === "ADM1" && f[10]))) {
					adminRows.push(f)
				}
			}
		}

		// #936: V2 tags for this country's P-class rows — geonameid → exact alias spelling → tag. The V2
		// dump repeats one spelling under several languages ("Åbo" sv/da/no); the merged tag is official /
		// preferred if ANY qualifying row is.
		const v2 = readV2 ? await parseAlternateNamesV2(v2File!, cc, wanted) : undefined

		// #267 admin pre-pass (gap countries): fold the country (PCLI) + regions (ADM1), self+ancestry them, and
		// build the admin1→region map the localities link through. Point bbox (GeoNames gives a centroid only).
		let countryID = -1
		const adminMap = new Map<string, number>()

		if (addAdmin) {
			for (const f of adminRows) {
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

		// Emit pass — a second stream over the same file, off the page cache the survey pass just warmed.
		for await (const f of TSVSpliterator.fromAsync(file, { header: false })) {
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

			// The SELF row is unconditional (#1514). `populateAncestors` writes one for every spr row it
			// sees, so a full build's freeze phase produces it either way — but the freeze does not run on
			// the fold-on-copy path, and since the purge now clears this range the fold has to emit
			// everything the closure would. Measured on the 161-country fold: 212,993 self rows, exactly the
			// non-gap countries' localities, which is what the base artifact carried and a fold-on-copy lost.
			ancestorInsert.run(nid, nid, "locality")

			if (addAdmin) {
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
