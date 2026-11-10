/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { DatabaseClient, StatementSync } from "@mailwoman/sqlite/client"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"

import type { WOFDatabase } from "#schema"

const FOLD_OWNED_TABLES = ["spr", "names", "place_population", "ancestors"] as const

/**
 * Deletes every row the GeoNames alias fold owns, with ids in
 * `[GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE)`, and returns the count removed per table.
 *
 * Fold ids are assigned sequentially, so a re-fold without this purge would attach
 * stale names, ancestors and populations to other places.
 * The upper bound leaves the postal and postcode id ranges above it untouched.
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
 * One progress event per country dump that the ingest processed or skipped.
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
	 * Whether the country's `<CC>.txt` dump was missing.
	 *
	 * A missing dump skips the country without failing the ingest.
	 */
	skipped: boolean

	/**
	 * The number of alternate names that the alias filter rejected.
	 *
	 * It distinguishes a sparse source from aliases that the fold discarded.
	 */
	aliasesRefused: number | null

	/**
	 * The number of populated places that matched an existing record and added their
	 * names to it, or null when the fold had no matcher.
	 */
	matched?: number | null
}

/**
 * Formats a GeoNames fold progress event as one log line.
 */
export function formatGeonamesIngestProgress(event: GeonamesIngestProgress, missingFile?: PathBuilderLike): string {
	if (event.skipped) {
		return `${event.country}: ${missingFile ? `${missingFile} missing` : "dump missing"} — download from download.geonames.org/export/dump/${event.country}.zip; skipped`
	}

	const matched = event.matched == null ? "" : `, ${event.matched.toLocaleString()} matched an existing record`

	return `${event.country}: ${event.places.toLocaleString()} places${matched}, ${(event.aliasesRefused ?? 0).toLocaleString()} alt-names refused`
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
 * A GeoNames place the fold is about to write.
 */
export interface GeonamesFoldPlace {
	geonamesID: number
	name: string
	placetype: "country" | "region" | "locality"
	country: string
	latitude: number
	longitude: number
}

/**
 * The record a GeoNames place matched in the database being folded into.
 */
export interface GeonamesFoldMatch {
	id: number
	placetype: string
}

/**
 * Matches GeoNames places against the records already in the database being folded into.
 */
export interface GeonamesFoldMatcher {
	match(place: GeonamesFoldPlace): GeonamesFoldMatch | null
	/**
	 * Answers whether the matched record lacks a name, recording it so the name is written once.
	 */
	claimName(match: GeonamesFoldMatch, country: string, name: string): boolean
	onGap(place: GeonamesFoldPlace & { id: number }): void
}

/**
 * Folds one country's GeoNames `A`-class rows, its country and its ADM1 regions,
 * and links each region the fold wrote to the country.
 *
 * A row that matches an existing record writes no row and adds its name to that record,
 * and its id is the existing record's.
 * Only regions the fold wrote are re-parented, so an existing region keeps its own parent.
 */
function foldAdminRows(
	statements: { db: DatabaseClient<WOFDatabase>; spr: StatementSync; names: StatementSync; ancestors: StatementSync },
	input: {
		rows: readonly string[][]
		country: string
		clean: (s: string) => string | null
		existing: GeonamesFoldMatcher | undefined
		claim: (match: GeonamesFoldMatch, name: string) => void
		nextID: number
	}
): { countryID: number; adminMap: Map<string, number>; nextID: number } {
	const { rows, country: cc, clean, existing, claim } = input
	let id = input.nextID
	let countryID = -1
	const adminMap = new Map<string, number>()
	// The regions this fold wrote, as opposed to existing records a region matched.
	const writtenRegions = new Set<number>()

	for (const f of rows) {
		const aname = clean(f[2] ?? "") ?? clean(f[1] ?? "")

		if (!aname) continue
		const lat = Number(f[4]) || 0
		const lon = Number(f[5]) || 0
		const placetype: GeonamesFoldPlace["placetype"] = f[7]?.startsWith("PCL") ? "country" : "region"

		if (placetype === "country" && countryID >= 0) continue

		if (placetype === "region" && !(f[7] === "ADM1" && f[10])) continue

		const place = { geonamesID: Number(f[0]), name: aname, placetype, country: cc, latitude: lat, longitude: lon }
		const matched = existing?.match(place) ?? null

		if (matched) {
			claim(matched, aname)
		}

		const rid = matched?.id ?? id++

		if (!matched) {
			statements.spr.run(rid, -1, aname, placetype, cc, lat, lon, lat, lon, lat, lon, 1, 0, 0, 0, 0, 0)
			statements.names.run(rid, aname, placetype, cc, "", "", 0, 0)
			statements.ancestors.run(rid, rid, placetype)
			existing?.onGap({ ...place, id: rid })
		}

		if (placetype === "country") {
			countryID = rid
		} else {
			adminMap.set(f[10]!, rid)

			if (!matched) {
				writtenRegions.add(rid)
			}
		}
	}

	if (countryID >= 0) {
		for (const rid of writtenRegions) {
			statements.db.prepare("UPDATE spr SET parent_id = ? WHERE id = ?").run(countryID, rid)
			statements.ancestors.run(rid, countryID, "country")
		}
	}

	return { countryID, adminMap, nextID: id }
}

/**
 * Purges the fold's id range, then adds GeoNames `P`-class places and their
 * alternate names for `countries` to `db`.
 * It returns the number of places ingested.
 *
 * The caller must then rebuild `place_search` with `buildPlaceSearchFTS(db, { drop: true })`
 * to make the new names searchable.
 */
export async function ingestGeonamesAliases(
	db: DatabaseClient<WOFDatabase>,
	countries: string[],
	geonamesDir: PathBuilderLike,
	onProgress?: (event: GeonamesIngestProgress) => void,
	opts?: {
		adminForCountries?: ReadonlySet<string>

		alternateDir?: PathBuilderLike
		/**
		 * The records already in `db` to match against.
		 *
		 * A GeoNames place that matches one adds its names to that record and writes no row.
		 * A place that matches none is written and reported to `onGap`.
		 */
		existing?: GeonamesFoldMatcher
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
		`INSERT INTO names (id, name, placetype, country, language, privateuse, official, lastmodified, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'geonames')`
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
			report({ country: cc, places: 0, skipped: true, aliasesRefused: null }, file)

			continue
		}

		let nc = 0
		let refused = 0
		let matchedPlaces = 0

		const addAdmin = opts?.adminForCountries?.has(cc) ?? false
		const v2File = opts?.alternateDir ? resolvePathBuilder(opts.alternateDir, `${cc}.txt`) : null
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

		const v2 = readV2 ? await parseAlternateNamesV2(v2File!, cc, wanted) : null

		/**
		 * Writes a place's name onto the existing record it matched, once.
		 */
		const claim = (match: GeonamesFoldMatch, name: string, language = "", privateuse = "", official = 0) => {
			if (opts?.existing?.claimName(match, cc, name)) {
				namesInsert.run(match.id, name, match.placetype, cc, language, privateuse, official, 0)
			}
		}

		const admin = addAdmin
			? foldAdminRows(
					{ db, spr: sprInsert, names: namesInsert, ancestors: ancestorInsert },
					{ rows: adminRows, country: cc, clean, existing: opts?.existing, claim, nextID: id }
				)
			: { countryID: -1, adminMap: new Map<string, number>(), nextID: id }

		const { countryID, adminMap } = admin

		id = admin.nextID

		for await (const f of readUnquotedTSV(file)) {
			if (f[6] !== "P") continue
			const lat = Number(f[4])
			const lon = Number(f[5])

			if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
			const name = clean(f[1] ?? "")

			if (!name) continue

			const tags = v2?.get(Number(f[0]))
			const alternates = [f[2] ?? "", ...(f[3] ? f[3].split(",") : [])]

			const place = {
				geonamesID: Number(f[0]),
				name,
				placetype: "locality" as const,
				country: cc,
				latitude: lat,
				longitude: lon,
			}

			const matched = opts?.existing?.match(place) ?? null

			if (matched) {
				claim(matched, name)

				for (const raw of alternates) {
					const alt = cleanAlias(raw)

					if (!alt && raw.trim()) {
						refused++
					}

					if (alt) {
						const tag = tags?.get(alt)

						claim(matched, alt, tag?.language ?? "", tag?.privateuse ?? "", tag?.official ?? 0)
					}
				}

				matchedPlaces++

				continue
			}

			const nid = id++

			opts?.existing?.onGap({ ...place, id: nid })

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

			for (const raw of alternates) {
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

		report({
			country: cc,
			places: nc,
			skipped: false,
			aliasesRefused: refused,
			matched: opts?.existing ? matchedPlaces : null,
		})

		total += nc
	}

	db.exec("COMMIT")

	return total
}
