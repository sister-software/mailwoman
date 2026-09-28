/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a CJK postcode → WOF locality table by authoritative name match.
 *
 *   WOF admin geometry in CJK (JP/KR/TW) is point-based at the municipality/locality level, so the
 *   European coordinate-first point-in-polygon build in build-postcode-locality.ts does not apply.
 *   This is the CJK substitute:
 *
 *   Postcode --(national postal authority)--> municipality name (romanized) postcode --(GeoNames)-->
 *   point municipality name + point --(cross-placetype name+proximity match)--> WOF place id
 *
 *   The match searches all the municipality-ish WOF placetypes (locality + county + localadmin +
 *   borough), because CJK municipalities are split across them (regular cities → locality, wards →
 *   county/localadmin, Tokyo special wards → borough).
 *
 *   Output is the standard `postcode_locality` table, so the existing `postcode_area_resolution`
 *   resolver strategy consumes it unchanged (is_containing=1 for the name-matched municipality).
 *   The authoritative names come from the national postal file (JP = KEN_ALL, Japan Post), and
 *   points from GeoNames. Both are source material rather than prebuilt dumps.
 *
 *   Usage (JP): node scripts/build-postcode-locality-cjk.ts --country JP\
 *   --postal-names $MAILWOMAN_DATA_ROOT/KEN_ALL_ROME/KEN_ALL_ROME.CSV\
 *   --geonames $MAILWOMAN_DATA_ROOT/geonames/JP.txt\
 *   --admin-db $MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db\
 *   --output $MAILWOMAN_DATA_ROOT/db/wof/postcode-locality-jp.db
 *
 *   With no polygons there is no point-in-polygon step, so matching is name plus haversine
 *   proximity through `@mailwoman/spatial`'s `haversineKm` (asin form, matching Python). The
 *   output is written directly to `--output` as a full single-country rebuild.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { decodeBytes } from "@mailwoman/core/fs/streams"
import { pyRound } from "@mailwoman/core/numeric"
import { isoSecondsUTC } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { CSVSpliterator } from "spliterator"

import { finalizeSealedBuild } from "#gazetteer-pipeline/database-lifecycle"
import { geonamesPostalRows } from "#gazetteer-pipeline/postcode/geonames/postal"
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
 * Columns a Japan Post KEN_ALL row needs before it is usable.
 */
const MIN_KEN_ALL_COLUMNS = 6

/**
 * Digits in a JIS local-government code, the first KEN_ALL field.
 */
const JIS_CODE_LENGTH = 7

const MATCH_RADIUS_KM = 15
/**
 * Extra non-containing candidates kept for the soft-score set.
 */
const NEARBY_KEEP = 2
const PLACETYPES = ["locality", "county", "localadmin", "borough"] as const
const SUFFIX = /(shi|ku|cho|machi|gun|ken|fu|to|son|mura|ward|si|gu|dong|eup|myeon|ri)$/

function norm(s: string): string {
	return s.normalize("NFKD").replaceAll(/\p{M}/gu, "").toLowerCase().replaceAll(/[\s-]/g, "")
}

/**
 * The WOF place name (suffix-stripped) appears as a token in the authoritative
 * municipality string (which carries city+ward, e.g. 'sapporo SHI chuo KU').
 */
function nameMatches(wofName: string, postalMuni: string): boolean {
	const nw = norm(wofName).replace(SUFFIX, "")

	return nw.length >= 2 && norm(postalMuni).includes(nw)
}

/**
 * JP KEN_ALL_ROME (CP932): col0=postcode(7-digit), col5=municipality romaji → {NNN-nnnn: muni}.
 */
async function loadKenall(path: string): Promise<Map<string, string>> {
	const out = new Map<string, string>()

	// `cp932` through iconv rather than `TextDecoder("shift_jis")`. Japan Post ships CP932, and
	// Node's whatwg `shift_jis` reads 801 of CP932's 20,296 two-byte sequences differently, most
	// yielding a different character rather than a replacement. The file is reissued monthly, so
	// this must stay exact.
	const text = decodeBytes(await readLocalBuffer(path), "cp932")

	// KEN_ALL has no header row.
	for (const f of CSVSpliterator.from<string[]>(text, { header: false })) {
		if (f.length >= MIN_KEN_ALL_COLUMNS && f[0]!.length === JIS_CODE_LENGTH && /^[0-9]+$/.test(f[0]!)) {
			out.set(`${f[0]!.slice(0, 3)}-${f[0]!.slice(3)}`, f[5]!)
		}
	}

	return out
}

/**
 * GeoNames postal file → {postcode (NNN-nnnn): [lat, lon]} (last row for a postcode wins).
 */
async function loadGeonamesPoints(path: string): Promise<Map<string, [number, number]>> {
	const out = new Map<string, [number, number]>()

	// `path` is a caller-supplied national dump, so the rows are streamed.
	for await (const row of geonamesPostalRows(path)) {
		out.set(row.postcode, [row.latitude, row.longitude])
	}

	return out
}

export interface PostcodeLocalityJPOptions {
	country: string
	postalNames: string
	geonames: string
	adminDB: string
	output: string
}

export async function buildPostcodeLocalityJP(args: PostcodeLocalityJPOptions): Promise<void> {
	const postal = args.country === "JP" ? await loadKenall(args.postalNames) : new Map<string, string>()

	if (!postal.size) {
		console.error(`no postal names loaded for ${args.country} (only KEN_ALL/JP wired so far)`)

		process.exit(1)
	}

	const points = await loadGeonamesPoints(args.geonames)

	using admin = new DatabaseClient<PostcodeLocalityDatabase>(args.adminDB)
	const ph = PLACETYPES.map(() => "?").join(",")

	const places = admin
		.prepare(
			`SELECT id,name,latitude,longitude FROM spr WHERE country=? AND placetype IN (${ph}) ` +
				`AND latitude IS NOT NULL AND NOT (latitude=0 AND longitude=0)`
		)
		.all(args.country, ...PLACETYPES) as Array<{ id: number; name: string; latitude: number; longitude: number }>

	const grid = new ProximityGrid<{ pid: number; nm: string; la: number; lo: number }>({
		cellOf: (lon, lat) => [pyRound(lon * 2), pyRound(lat * 2)],
		positionOf: (entry) => [entry.la, entry.lo],
		compare: (a, b) => a.pid - b.pid || (a.nm < b.nm ? -1 : a.nm > b.nm ? 1 : 0),
	})

	for (const { id, name, latitude, longitude } of places) {
		grid.add({ pid: id, nm: name, la: latitude, lo: longitude })
	}

	const nearby = (lat: number, lon: number): Array<{ d: number; pid: number; nm: string }> =>
		grid.nearby(lat, lon, MATCH_RADIUS_KM).map(({ d, entry }) => ({ d, pid: entry.pid, nm: entry.nm }))

	const keys = [...postal.keys()].filter((k) => points.has(k))
	let matched = 0
	const matchRate = `${((100 * matched) / keys.length).toFixed(1)}%`
	const rows: PostcodeLocalityInsertValues[] = []

	{
		using kdb = new DatabaseClient<PostcodeLocalityDatabase>(args.output)

		await kdb.schema.dropTable("postcode_locality").ifExists().execute()

		await createPostcodeLocalityTable(kdb, { ifNotExists: false })

		for (const pc of keys) {
			const muni = postal.get(pc)!
			const [lat, lon] = points.get(pc)!
			const cands = nearby(lat, lon)

			if (!cands.length) continue
			const hit = cands.find((c) => nameMatches(c.nm, muni))

			if (hit) {
				matched++
				rows.push([pc, args.country, hit.pid, hit.nm, muni, pyRound(hit.d, 3), 1])

				for (const c2 of cands.slice(0, NEARBY_KEEP)) {
					if (c2.pid !== hit.pid) {
						rows.push([pc, args.country, c2.pid, c2.nm, muni, pyRound(c2.d, 3), 0])
					}
				}
			} else {
				const c0 = cands[0]!
				rows.push([pc, args.country, c0.pid, c0.nm, muni, pyRound(c0.d, 3), 0])
			}
		}

		const insert = kdb.prepare(POSTCODE_LOCALITY_INSERT_SQL)
		kdb.exec("BEGIN")

		for (const r of rows) {
			insert.run(...r)
		}

		kdb.exec("COMMIT")

		await createPostcodeLocalityIndex(kdb, { ifNotExists: false })

		await createPostcodeLocalityMetaTable(kdb, { ifNotExists: true })

		const meta: Array<[string, string]> = [
			["name", "mailwoman-postcode-locality-cjk"],
			["description", "CJK postcode -> WOF locality via authoritative-name + proximity match (no polygons)"],
			["method", "national-postal-authority municipality NAME + GeoNames point -> cross-placetype WOF match"],
			["source", `${args.country}: KEN_ALL_ROME (Japan Post, romanized) + GeoNames postal points; built from source`],
			["country", args.country],
			["postcodes_total", String(keys.length)],
			["postcodes_matched", String(matched)],
			["match_rate", matchRate],
			["built_at", isoSecondsUTC()],
		]

		writeMetaRows(kdb, meta)

		finalizeSealedBuild(kdb, args.output)
	}

	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	await sealDatabase(args.output)

	console.log(
		`${args.country}: ${keys.length.toLocaleString("en-US")} postcodes (KEN_ALL∩GeoNames), ` +
			`${matched.toLocaleString("en-US")} name-matched (${matchRate}), ` +
			`${rows.length.toLocaleString("en-US")} rows -> ${args.output}`
	)
}
