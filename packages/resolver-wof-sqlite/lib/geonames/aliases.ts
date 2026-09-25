/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers"
import { GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"

import type { WOFDatabase } from "#schema"

const FOLD_OWNED_TABLES = ["spr", "names", "place_population", "ancestors"] as const

/**
 * Deletes every row the GeoNames alias fold owns, ids in `[GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE)`,
 * and returns the count removed per table.
 *
 * Fold ids are positional, so a re-fold without this purge binds stale names,
 * ancestors and populations to other places.
 * The upper bound protects the postal and postcode extracts whose id ranges sit above it.
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
	 * The ISO 3166-1 alpha-2 country code.
	 */
	country: string

	/**
	 * The number of populated places ingested from this country's dump, or 0 when it was skipped.
	 */
	places: number

	/**
	 * Whether the country's `<CC>.txt` dump was missing, which skips the country
	 * instead of failing the ingest.
	 */
	skipped: boolean

	/**
	 * The number of alternate names the admission rule refused, which separates a
	 * sparse source from names the fold discarded.
	 */
	aliasesRefused?: number
}

/**
 * Formats a GeoNames fold progress event as the single log line every caller prints.
 */
export function formatGeonamesIngestProgress(event: GeonamesIngestProgress, missingFile?: PathBuilderLike): string {
	if (event.skipped) {
		return `${event.country}: ${missingFile ? `${missingFile} missing` : "dump missing"} — download from download.geonames.org/export/dump/${event.country}.zip; skipped`
	}

	return `${event.country}: ${event.places.toLocaleString()} places, ${(event.aliasesRefused ?? 0).toLocaleString()} alt-names refused`
}

interface V2Alias {
	language: string
	privateuse: string
	official: number
}

async function parseAlternateNamesV2(
	v2File: PathBuilderLike,
	cc: string,
	wanted: ReadonlySet<number>
): Promise<Map<number, Map<string, V2Alias>>> {
	const v2 = new Map<number, Map<string, V2Alias>>()

	const historicNames = new Set<string>()

	for await (const f of readUnquotedTSV(v2File)) {
		if (f[6] === "1" || f[7] === "1" || (f[9] ?? "").trim() !== "") {
			const alt = (f[3] ?? "").trim()

			if (alt && wanted.has(Number(f[1]))) {
				historicNames.add(`${f[1]}|${alt}`)
			}
		}
	}

	for await (const f of readUnquotedTSV(v2File)) {
		const gid = Number(f[1])

		if (!wanted.has(gid)) continue
		const lang = f[2] ?? ""

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
 * Purges the fold's id range and then folds GeoNames `P`-class places and their alternate
 * names for `countries` into `db`, returning the number of places ingested.
 *
 * The caller must then rebuild `place_search` with `buildPlaceSearchFTS(db, { drop: true })`
 * for the new names to be searchable.
 */
export async function ingestGeonamesAliases(
	db: DatabaseClient<WOFDatabase>,
	countries: string[],
	geonamesDir: PathBuilderLike,
	onProgress?: (event: GeonamesIngestProgress) => void,
	opts?: {
		adminForCountries?: ReadonlySet<string>

		alternateDir?: PathBuilderLike
	}
): Promise<number> {
	const LATIN_NAME = /^[\p{Script=Latin}\p{M}\s\-'.]{2,60}$/u

	const clean = (s: string): string | null => {
		const t = s.trim()

		return t && LATIN_NAME.test(t) && /\p{L}/u.test(t) ? t : null
	}

	const NAME_NOISE = /[()[\]{}<>|/\\_@#$%^*+=~`"]/u

	const NAME_MIN_LENGTH = 2
	const NAME_MAX_LENGTH = 60

	const cleanAlias = (s: string): string | null => {
		const t = s.trim()

		return t.length >= NAME_MIN_LENGTH && t.length <= NAME_MAX_LENGTH && /\p{L}/u.test(t) && !NAME_NOISE.test(t)
			? t
			: null
	}

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)

	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, privateuse, official, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)

	const populationInsert = db.prepare(`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`)

	const ancestorInsert = db.prepare(
		`INSERT INTO ancestors (id, ancestor_id, ancestor_placetype, lastmodified) VALUES (?, ?, ?, 0)`
	)

	const report = (event: GeonamesIngestProgress, missingFile?: PathBuilderLike): void => {
		if (onProgress) {
			onProgress(event)
		} else {
			console.error(`  GeoNames ${formatGeonamesIngestProgress(event, missingFile)}`)
		}
	}

	let id = GEONAMES_ID_BASE
	let total = 0
	db.exec("BEGIN")

	purgeGeonamesAliasRange(db)

	for (const cc of countries) {
		const file = resolvePathBuilder(geonamesDir, `${cc}.txt`)

		if (!(await pathExists(file))) {
			report({ country: cc, places: 0, skipped: true }, file)

			continue
		}

		let nc = 0
		let refused = 0

		const addAdmin = opts?.adminForCountries?.has(cc) ?? false
		const v2File = opts?.alternateDir ? resolvePathBuilder(opts.alternateDir, `${cc}.txt`) : undefined
		const readV2 = Boolean(v2File && (await pathExists(v2File)))

		const wanted = new Set<number>()
		const adminRows: string[][] = []

		if (readV2 || addAdmin) {
			for await (const f of readUnquotedTSV(file)) {
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

		const v2 = readV2 ? await parseAlternateNamesV2(v2File!, cc, wanted) : undefined

		let countryID = -1
		const adminMap = new Map<string, number>()

		if (addAdmin) {
			for (const f of adminRows) {
				const aname = clean(f[2] ?? "") ?? clean(f[1] ?? "")

				if (!aname) continue
				const lat = Number(f[4]) || 0
				const lon = Number(f[5]) || 0

				if (f[7]?.startsWith("PCL")) {
					if (countryID >= 0) continue
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

			if (countryID >= 0) {
				for (const rid of adminMap.values()) {
					db.prepare("UPDATE spr SET parent_id = ? WHERE id = ?").run(countryID, rid)
					ancestorInsert.run(rid, countryID, "country")
				}
			}
		}

		for await (const f of readUnquotedTSV(file)) {
			if (f[6] !== "P") continue
			const lat = Number(f[4])
			const lon = Number(f[5])

			if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
			const name = clean(f[1] ?? "")

			if (!name) continue
			const nid = id++

			const regionID = addAdmin ? (adminMap.get(f[10] ?? "") ?? -1) : -1
			const parentID = regionID >= 0 ? regionID : addAdmin && countryID >= 0 ? countryID : -1

			sprInsert.run(nid, parentID, name, "locality", cc, lat, lon, lat, lon, lat, lon, 1, 0, 0, 0, 0, 0)
			namesInsert.run(nid, name, "locality", cc, "", "", 0, 0)

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
				const alt = cleanAlias(raw)

				if (!alt && raw.trim()) {
					refused++
				}

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

		report({ country: cc, places: nc, skipped: false, aliasesRefused: refused })
		total += nc
	}

	db.exec("COMMIT")

	return total
}
