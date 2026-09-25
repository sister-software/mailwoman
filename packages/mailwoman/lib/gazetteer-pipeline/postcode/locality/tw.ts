/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds Taiwan's table from 3-digit postcodes to WOF districts, using Chunghwa Post district
 *   centers, Overture division polygons, and the WOF admin database.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { movePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { isoSecondsUTC } from "@mailwoman/core/utils"
import { geometryContains, haversineKm, type ParsedGeometry } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { JSONSpliterator } from "spliterator"

import { finalizeSealedBuild } from "#gazetteer-pipeline/database-lifecycle"
import { writeMetaRows } from "#gazetteer-pipeline/postcode/geonames/tail"
import { ProximityGrid } from "#gazetteer-pipeline/postcode/locality/base"
import {
	createPostcodeLocalityIndex,
	createPostcodeLocalityMetaTable,
	createPostcodeLocalityTable,
	POSTCODE_LOCALITY_INSERT_SQL,
	type PostcodeLocalityDatabase,
	type PostcodeLocalityInsertValues,
} from "#gazetteer-pipeline/postcode/locality/schema"

/**
 * The shortest romanized stem that is specific enough to match a Taiwanese place name.
 */
const MIN_ENGLISH_STEM_LENGTH = 3

/**
 * The number of extra non-containing candidates kept per postcode for the resolver's soft score.
 */
const NEARBY_KEEP = 2
/**
 * The search radius in kilometres around the official center when no polygon matches.
 */
const FALLBACK_RADIUS_KM = 20
/**
 * The WOF placetypes that can represent a district.
 * Neighbourhoods qualify only through a name match.
 */
const PLACETYPES = ["locality", "county", "localadmin", "borough", "neighbourhood"] as const
/**
 * The district-level WOF placetypes, preferred inside a polygon.
 */
const DISTRICT_TIER = new Set(["county", "localadmin"])
const DISTRICT_SUFFIX = /[區鄉鎮市]$/

/**
 * The length of the county or city prefix in postal district names.
 */
const COUNTY_PREFIX_LENGTH = 3

/**
 * Normalizes a Chinese name by folding 臺 to 台 and removing whitespace and hyphens.
 */
export function normHan(s: string): string {
	return s
		.normalize("NFC")
		.replaceAll("臺", "台")
		.replaceAll(/[\s　-]/g, "")
}

/**
 * Normalizes a romanized name by removing diacritics, case, separators, and common tier suffixes.
 */
export function normEn(s: string): string {
	return (
		s
			.normalize("NFKD")
			.replaceAll(/\p{M}/gu, "")
			.toLowerCase()
			// WOF sometimes carries the romanized 區, 鄉, and 鎮 suffixes, as in "Zhongzheng Qu".
			.replaceAll(/\s+(district|township|city|county|village|islands?|qu|xiang|zhen)$/g, "")
			.replaceAll(/[\s'’-]/g, "")
	)
}

/**
 * One postal district from the Chunghwa Post table.
 */
export interface PostalDistrict {
	/**
	 * The full district name, such as 臺北市中正區.
	 */
	name: string
	/**
	 * The three-character county or city prefix, such as 臺北市.
	 */
	county: string
	/**
	 * The rest of the name, such as 中正區.
	 */
	district: string
	/**
	 * The 3-digit postcode.
	 */
	postcode: string
	lat: number
	lon: number
}

/**
 * Parses Chunghwa Post's `行政區經緯度(toPost).xml` from data.gov.tw dataset 25489.
 *
 * The file is flat, so a regular expression reads each entry's name, postcode, and center.
 */
export async function loadPostalDistricts(path: string): Promise<PostalDistrict[]> {
	const xml = await readLocalTextFile(path)

	const re =
		/<行政區名>([^<]+)<\/行政區名>\s*<_x0033_碼郵遞區號>(\d+)<\/_x0033_碼郵遞區號>\s*<中心點經度>([\d.]+)<\/中心點經度>\s*<中心點緯度>([\d.]+)<\/中心點緯度>/g

	const out: PostalDistrict[] = []

	for (const m of xml.matchAll(re)) {
		const name = m[1]!.trim()
		const lat = Number(m[4])
		const lon = Number(m[3])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

		out.push({
			name,
			county: name.slice(0, COUNTY_PREFIX_LENGTH),
			district: name.slice(COUNTY_PREFIX_LENGTH),
			postcode: m[2]!,
			lat,
			lon,
		})
	}

	return out
}

/**
 * One Overture district polygon.
 */
export interface DivisionPolygon {
	/**
	 * The Overture primary name in full Chinese form, such as 萬華區.
	 */
	name: string
	nameHan: string
	/**
	 * Overture's English name, such as "Wanhua District".
	 *
	 * It matches WOF rows that have no Chinese names, such as the `county` tier.
	 */
	nameEn: string | null
	/**
	 * The Wikidata QID from the joined `division` row, matched against WOF `wd:id` concordances.
	 */
	wikidata: string | null
	geometry: ParsedGeometry
	bbox: [number, number, number, number] // minLon, minLat, maxLon, maxLat
}

/**
 * Loads the `locality` district polygons fetched from the Overture divisions theme.
 */
export async function loadDistrictPolygons(path: string): Promise<DivisionPolygon[]> {
	const out: DivisionPolygon[] = []

	interface DivisionRow {
		subtype: string
		name: string
		name_en?: string | null
		wikidata?: string | null
		geometry: string | ParsedGeometry
	}

	for await (const row of JSONSpliterator.fromAsync<DivisionRow>(path)) {
		if (row.subtype !== "locality") continue

		// DuckDB writes the geometry as a nested object, but a string is also accepted.
		const geometry = typeof row.geometry === "string" ? parseJSONStrict<ParsedGeometry>(row.geometry) : row.geometry

		let minLon = Infinity
		let minLat = Infinity
		let maxLon = -Infinity
		let maxLat = -Infinity

		const scan = (coords: unknown): void => {
			if (Array.isArray(coords) && typeof coords[0] === "number") {
				const [lon, lat] = coords as [number, number]

				if (lon < minLon) {
					minLon = lon
				}

				if (lon > maxLon) {
					maxLon = lon
				}

				if (lat < minLat) {
					minLat = lat
				}

				if (lat > maxLat) {
					maxLat = lat
				}

				return
			}

			if (Array.isArray(coords)) {
				for (const c of coords) {
					scan(c)
				}
			}
		}

		scan((geometry as { coordinates?: unknown }).coordinates)

		out.push({
			name: row.name,
			nameHan: normHan(row.name),
			nameEn: row.name_en ?? null,
			wikidata: row.wikidata ?? null,
			geometry,
			bbox: [minLon, minLat, maxLon, maxLat],
		})
	}

	return out
}

/**
 * Input and output paths for {@link buildPostcodeLocalityTW}.
 */
export interface PostcodeLocalityTWOptions {
	postalXML: string
	divisions: string
	adminDB: string
	output: string
}

interface AdminPlace {
	pid: number
	/**
	 * The romanized `spr` name.
	 */
	nm: string
	placetype: string
	la: number
	lo: number
	/**
	 * Chinese names from the names table, normalized with {@link normHan}.
	 * The `county` tier has none.
	 */
	hanNames: Set<string>
	/**
	 * Romanized stems from `spr.name` and English names, normalized with {@link normEn}.
	 */
	engNames: Set<string>
}

/**
 * Reads the WOF admin data that district matching needs into memory, then closes the database.
 *
 * It returns the places with their name forms, the regions keyed by Chinese name,
 * the places keyed by Wikidata QID, and a proximity search over 0.5-degree cells.
 */
function loadAdminIndexes(args: { adminDB: string }) {
	using admin = new DatabaseClient<PostcodeLocalityDatabase>(args.adminDB)
	const ph = PLACETYPES.map(() => "?").join(",")
	const places = new Map<number, AdminPlace>()

	for (const row of admin
		.prepare(
			`SELECT id, name, placetype, latitude, longitude FROM spr WHERE country='TW' AND placetype IN (${ph})
			 AND latitude IS NOT NULL AND NOT (latitude=0 AND longitude=0)`
		)
		.all(...PLACETYPES) as Array<{
		id: number
		name: string
		placetype: string
		latitude: number
		longitude: number
	}>) {
		places.set(row.id, {
			pid: row.id,
			nm: row.name,
			placetype: row.placetype,
			la: row.latitude,
			lo: row.longitude,
			hanNames: new Set(),
			engNames: new Set([normEn(row.name)]),
		})
	}

	// Names containing Han characters are Chinese forms.
	// Other English names are romanized variants.
	for (const row of admin
		.prepare(
			`SELECT n.id, n.name, n.language FROM names n JOIN spr s ON s.id = n.id
			 WHERE s.country='TW' AND s.placetype IN (${ph}) AND n.language IN ('zho','und','eng')`
		)
		.all(...PLACETYPES) as Array<{ id: number; name: string; language: string }>) {
		const place = places.get(row.id)

		if (!place) continue

		if (/[一-鿿]/.test(row.name)) {
			place.hanNames.add(normHan(row.name))
		} else if (row.language === "eng") {
			place.engNames.add(normEn(row.name))
		}
	}

	// Regions serve as the containing-city fallback for districts that WOF lacks.
	// They are keyed by normalized Chinese name so the postal county prefix can find them.
	const regionsByHan = new Map<string, AdminPlace>()

	for (const row of admin
		.prepare(
			`SELECT s.id, s.name, s.latitude, s.longitude, n.name AS han FROM spr s
			 JOIN names n ON n.id = s.id AND n.language IN ('zho','und')
			 WHERE s.country='TW' AND s.placetype='region' AND s.latitude IS NOT NULL`
		)
		.all() as Array<{ id: number; name: string; latitude: number; longitude: number; han: string }>) {
		if (!/[一-鿿]/.test(row.han)) continue

		regionsByHan.set(normHan(row.han), {
			pid: row.id,
			nm: row.name,
			placetype: "region",
			la: row.latitude,
			lo: row.longitude,
			hanNames: new Set([normHan(row.han)]),
			engNames: new Set([normEn(row.name)]),
		})
	}

	// Wikidata concordances match districts whose WOF point lies outside their own polygon
	// and whose `county` row has no Chinese name.
	const placesByQID = new Map<string, AdminPlace[]>()

	for (const row of admin
		.prepare(
			`SELECT c.id, c.other_id AS qid FROM concordances c JOIN spr s ON s.id = c.id
			 WHERE c.other_source='wd:id' AND s.country='TW' AND s.placetype IN (${ph})`
		)
		.all(...PLACETYPES) as Array<{ id: number; qid: string }>) {
		const place = places.get(row.id)

		if (!place) continue
		const bucket = placesByQID.get(row.qid)

		if (bucket) {
			bucket.push(place)
		} else {
			placesByQID.set(row.qid, [place])
		}
	}

	// The proximity grid uses 0.5-degree cells, like the JP and KR builders.
	const grid = new ProximityGrid<AdminPlace>({
		cellOf: (lon, lat) => [Math.round(lon * 2), Math.round(lat * 2)],
		positionOf: (place) => [place.la, place.lo],
		compare: (a, b) => a.pid - b.pid,
	})

	for (const p of places.values()) {
		grid.add(p)
	}

	const nearby = (lat: number, lon: number, radiusKM: number): Array<{ d: number; place: AdminPlace }> =>
		grid.nearby(lat, lon, radiusKM).map(({ d, entry }) => ({ d, place: entry }))

	return { places, regionsByHan, placesByQID, nearby }
}

/**
 * Builds and seals the TW postcode-locality database.
 *
 * For each postal district, the build looks for a WOF row in this order: a district-tier
 * row inside the Overture polygon, a Wikidata concordance, a name match inside the polygon,
 * a name match within {@link FALLBACK_RADIUS_KM}, and finally the containing region.
 * It writes to `<output>.building` and moves the file into place only after the build succeeds.
 */
export async function buildPostcodeLocalityTW(args: PostcodeLocalityTWOptions): Promise<void> {
	const districts = await loadPostalDistricts(args.postalXML)

	if (!districts.length) {
		console.error(`no postal districts parsed from ${args.postalXML}`)

		process.exit(1)
	}

	const polygons = await loadDistrictPolygons(args.divisions)
	const polygonsByName = new Map<string, DivisionPolygon[]>()

	for (const p of polygons) {
		const bucket = polygonsByName.get(p.nameHan)

		if (bucket) {
			bucket.push(p)
		} else {
			polygonsByName.set(p.nameHan, [p])
		}
	}

	const { places, regionsByHan, placesByQID, nearby } = loadAdminIndexes(args)

	const buildPath = `${args.output}.building`
	await removePathIfPresent(buildPath)

	const rows: PostcodeLocalityInsertValues[] = []
	const tierCounts = { polygon: 0, wikidata: 0, name_in_polygon: 0, name_nearby: 0, region_fallback: 0 }
	const unmatched: string[] = []
	const matched = tierCounts.polygon + tierCounts.wikidata + tierCounts.name_in_polygon + tierCounts.name_nearby
	const matchRate = `${((100 * matched) / districts.length).toFixed(1)}%`

	{
		using kdb = new DatabaseClient<PostcodeLocalityDatabase>(buildPath)

		await createPostcodeLocalityTable(kdb, { ifNotExists: false })

		for (const d of districts) {
			const districtHan = normHan(d.district)
			const stemHan = districtHan.replace(DISTRICT_SUFFIX, "")

			const aliases = [d.name, d.district, normHan(d.name) !== d.name ? normHan(d.name) : ""]
				.filter(isPresent)
				.join("|")

			const hanMatches = (p: AdminPlace): boolean =>
				p.hanNames.has(districtHan) || (stemHan.length >= 2 && p.hanNames.has(stemHan))

			// The English stem comes from the matched polygon, so it is set once the polygon is known.
			let enStem = ""

			const nameMatches = (p: AdminPlace): boolean =>
				hanMatches(p) || (enStem.length >= MIN_ENGLISH_STEM_LENGTH && p.engNames.has(enStem))

			// Some district names repeat across cities, such as 中正區 in Taipei and Keelung.
			// The polygon containing the official center decides between them.
			const namesakes = polygonsByName.get(districtHan) ?? []

			const polygon =
				namesakes.length === 1
					? namesakes[0]
					: namesakes.find((p) => geometryContains(p.geometry, d.lon, d.lat) === true)

			let hit: { d: number; place: AdminPlace } | undefined
			let extras: Array<{ d: number; place: AdminPlace }> = []

			if (polygon) {
				enStem = polygon.nameEn ? normEn(polygon.nameEn) : ""
				const [minLon, minLat, maxLon, maxLat] = polygon.bbox
				const inside: Array<{ d: number; place: AdminPlace }> = []

				for (const p of places.values()) {
					if (p.lo < minLon || p.lo > maxLon || p.la < minLat || p.la > maxLat) continue

					if (geometryContains(polygon.geometry, p.lo, p.la) !== true) continue
					inside.push({ d: haversineKm(d.lat, d.lon, p.la, p.lo), place: p })
				}

				inside.sort((a, b) => a.d - b.d || a.place.pid - b.place.pid)

				// A neighbouring district's WOF point can fall inside this polygon,
				// so a district-tier row with a matching name comes first.
				// Any district-tier row inside the polygon comes next and outranks the Wikidata
				// concordance, because some TW concordances point at the wrong district.
				hit =
					inside.find((c) => DISTRICT_TIER.has(c.place.placetype) && nameMatches(c.place)) ??
					inside.find((c) => DISTRICT_TIER.has(c.place.placetype))

				if (hit) {
					tierCounts.polygon++
				} else if (polygon.wikidata) {
					const concordant = (placesByQID.get(polygon.wikidata) ?? [])
						.map((place) => ({ d: haversineKm(d.lat, d.lon, place.la, place.lo), place }))
						.toSorted(
							(a, b) =>
								Number(!DISTRICT_TIER.has(a.place.placetype)) - Number(!DISTRICT_TIER.has(b.place.placetype)) ||
								a.d - b.d
						)

					hit = concordant[0]

					if (hit) {
						tierCounts.wikidata++
					}
				}

				if (!hit) {
					// The English stem lets rows without Chinese names match here.
					hit = inside.find((c) => nameMatches(c.place))

					if (hit) {
						tierCounts.name_in_polygon++
					}
				}

				if (hit) {
					extras = inside.filter((c) => c.place.pid !== hit!.place.pid)
				}
			}

			if (!hit) {
				// Without a usable polygon, search by name near the official center.
				// The English stem also finds district rows whose WOF point lies outside their polygon.
				// Neighbourhood rows qualify only by name.
				const cands = nearby(d.lat, d.lon, FALLBACK_RADIUS_KM)
				const districtTierNameHit = cands.find((c) => DISTRICT_TIER.has(c.place.placetype) && nameMatches(c.place))
				const nameHit = districtTierNameHit ?? cands.find((c) => nameMatches(c.place))

				if (nameHit) {
					tierCounts.name_nearby++
					hit = nameHit
					extras = cands.filter((c) => c.place.pid !== nameHit.place.pid && c.place.placetype !== "neighbourhood")
				} else {
					// WOF has no row for this district, so the containing region from the county
					// prefix is recorded as a coarser containing match.
					// The meta table counts these separately.
					const region = regionsByHan.get(normHan(d.county))
					unmatched.push(d.name)

					if (region) {
						tierCounts.region_fallback++
						const dist = haversineKm(d.lat, d.lon, region.la, region.lo)
						rows.push([d.postcode, "TW", region.pid, region.nm, aliases, Math.round(dist * 1000) / 1000, 1])
					}

					// The first non-neighbourhood candidate is also recorded as non-containing,
					// so the resolver treats it as proximity evidence only.
					const weak = cands.find((c) => c.place.placetype !== "neighbourhood")

					if (weak) {
						rows.push([d.postcode, "TW", weak.place.pid, weak.place.nm, aliases, Math.round(weak.d * 1000) / 1000, 0])
					}

					continue
				}
			}

			rows.push([d.postcode, "TW", hit.place.pid, hit.place.nm, aliases, Math.round(hit.d * 1000) / 1000, 1])
			let kept = 0

			for (const c2 of extras) {
				rows.push([d.postcode, "TW", c2.place.pid, c2.place.nm, aliases, Math.round(c2.d * 1000) / 1000, 0])

				if (++kept >= NEARBY_KEEP) break
			}
		}

		const insert = kdb.prepare(POSTCODE_LOCALITY_INSERT_SQL)
		kdb.exec("BEGIN")

		for (const r of rows) {
			insert.run(...r)
		}

		kdb.exec("COMMIT")

		await createPostcodeLocalityIndex(kdb, { ifNotExists: false })

		// The build file is new, so `meta` cannot already exist.
		await createPostcodeLocalityMetaTable(kdb, { ifNotExists: false })

		const meta: Array<[string, string]> = [
			["name", "mailwoman-postcode-locality-tw"],
			["description", "TW 3-digit postcode -> WOF district via official center + Overture division polygon bridge"],
			[
				"method",
				"Chunghwa Post district table (official centers) -> containing Overture division polygon -> WOF row, tiered: " +
					"district-tier-inside > wikidata concordance > Chinese-name-inside > JP/KR-style name+proximity fallback",
			],
			[
				"source",
				"Chunghwa Post 行政區經緯度(toPost).xml via data.gov.tw dataset 25489 (OGDL v1) + Overture divisions " +
					"2026-06-17.0 (district polygons) + custom-built admin-tw.db (whosonfirst-data-admin-tw); built from source. " +
					"Overture addresses 2026-06-17.0 carries 0 TW postcodes (verified) — the postal authority table is the " +
					"only keying source. The 3+3 tail is road-segment granularity (below admin; full file account-conditional at " +
					"fpp.post.gov.tw); this table keys the 3-digit admin code.",
			],
			["country", "TW"],
			["postcodes_total", String(districts.length)],
			["postcodes_matched", String(matched)],
			["postcodes_by_tier", stringifyJSON(tierCounts)],
			["match_rate", matchRate],
			["unmatched", unmatched.join("|") || "(none)"],
			["built_at", isoSecondsUTC()],
		]

		writeMetaRows(kdb, meta)

		finalizeSealedBuild(kdb, buildPath)
	}

	await movePath(buildPath, args.output)
	await sealDatabase(args.output)

	console.log(
		`TW: ${districts.length} postal districts, ${matched} matched (${matchRate}; tiers ${stringifyJSON(tierCounts)}), ` +
			`${rows.length} rows -> ${args.output}` +
			(unmatched.length ? `\n  unmatched: ${unmatched.join(", ")}` : "")
	)
}
