/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a KR postcode → WOF locality table by point-primary match.
 *
 *   This is the South-Korea sibling of `build-postcode-locality-cjk.ts` (Japan). It emits the same
 *   `postcode_locality` table, so the existing `postcode_area_resolution` resolver strategy
 *   consumes it unchanged. KR's data shape is the inverse of Japan's, so the build is inverted too.
 *
 *   Japan is name-primary. KEN_ALL supplies the municipality name. GeoNames supplies the point.
 *   The builder matches the name with a proximity tiebreak against romanized `spr.name`. Korea is
 *   point-primary: the GeoNames postal file already maps postcode to (place_name, admin1, lat,
 *   lon) in one source. `spr.name` is romanized, but the WOF `names` table contains Hangul (`kor`
 *   plus Hangul-containing `und`) variants, so the nearest locality point resolves the postcode and
 *   the Hangul name confirms it where it exists.
 *
 *   These tiers use the same schema and semantics as the JP builder:
 *
 *   - Is_containing=1 : Hangul name-confirmed locality, the precise tier
 *   - Is_containing=0 : point-nearest fallback, with the province and coordinate correct
 *
 *   The province (admin1 to WOF region, Hangul-exact) is recorded in `meta` as the reliable coarse
 *   anchor. The build uses GeoNames postal KR plus our custom WOF admin-kr.db from the
 *   whosonfirst-data-admin-kr repo.
 *
 *   Usage: node scripts/build-postcode-locality-kr.ts\
 *   --geonames $MAILWOMAN_DATA_ROOT/geonames/KR.txt\
 *   --admin-db $MAILWOMAN_DATA_ROOT/db/wof/dbs-per-country/admin-kr.db\
 *   --output $MAILWOMAN_DATA_ROOT/db/wof/postcode-locality-kr.db
 *
 *   With no polygons there is no point-in-polygon step. The matcher uses point-nearest distance through
 *   `@mailwoman/spatial`'s `haversineKm` (asin form, matching Python), with
 *   proximity-constrained Hangul name confirmation. The output is written directly to
 *   `--output` as a full single-country rebuild.
 */

import { pyRound } from "@mailwoman/core/numeric"
import { isoSecondsUTC } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"

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
 * KR postcode points sit p50 ~1 km from the nearest locality. 20 km is a safe net.
 */
const MATCH_RADIUS_KM = 20
const HANGUL = /[가-힣]/
/**
 * Korean administrative suffixes, stripped to a bare stem so 추자면 ~ 추자, 강남구 ~ 강남, etc.
 */
const SUFFIX = /(특별자치도|특별자치시|광역시|특별시|면|동|읍|시|군|구|리)$/

/**
 * Python `str(float)`: integer-valued floats render with a trailing `.0` (e.g. `1.0`, `0.0`).
 */
function pyStrFloat(x: number): string {
	return Number.isInteger(x) ? `${x}.0` : String(x)
}

function norm(s: string | null | undefined): string {
	return (s || "").normalize("NFKC").replaceAll(/[\s-]/g, "").toLowerCase()
}

function bare(s: string | null | undefined): string {
	return norm(s).replace(SUFFIX, "")
}

export interface PostcodeLocalityKROptions {
	geonames: string
	adminDB: string
	output: string
}

export async function buildPostcodeLocalityKR(args: PostcodeLocalityKROptions): Promise<void> {
	using admin = new DatabaseClient<PostcodeLocalityDatabase>(args.adminDB)

	// Romanized `spr.name` for the human-readable row label.
	const loc = admin
		.prepare("SELECT id,name,latitude,longitude FROM spr WHERE placetype='locality' AND (latitude!=0 OR longitude!=0)")
		.all() as Array<{ id: number; name: string; latitude: number; longitude: number }>

	const xy = new Map<number, [number, number]>()
	const sprName = new Map<number, string>()

	const grid = new ProximityGrid<{ pid: number; la: number; lo: number }>({
		cellOf: (lon, lat) => [pyRound(lon * 2), pyRound(lat * 2)],
		positionOf: (entry) => [entry.la, entry.lo],
		compare: (a, b) => a.pid - b.pid,
	})

	for (const { id, name, latitude, longitude } of loc) {
		xy.set(id, [latitude, longitude])
		sprName.set(id, name)
		grid.add({ pid: id, la: latitude, lo: longitude })
	}

	// Hangul locality-name index: kor plus Hangul-containing und, bare-stem to set of ids.
	const nameIdx = new Map<string, Set<number>>()

	for (const lang of ["kor", "und"]) {
		const named = admin
			.prepare("SELECT id,name FROM names WHERE language=? AND placetype='locality'")
			.all(lang) as Array<{ id: number; name: string | null }>

		for (const { id: nid, name: nm } of named) {
			if (xy.has(nid) && nm && HANGUL.test(nm)) {
				const key = bare(nm)
				const set = nameIdx.get(key)

				if (set) {
					set.add(nid)
				} else {
					nameIdx.set(key, new Set([nid]))
				}
			}
		}
	}

	// Province (admin1) anchor: Hangul region name -> region id (records coarse-anchor coverage in meta).
	const regionIdx = new Set<string>()

	const regionRows = admin
		.prepare(
			"SELECT s.id,n.name FROM spr s JOIN names n ON n.id=s.id AND n.language IN ('kor','und') WHERE s.placetype='region'"
		)
		.all() as Array<{ id: number; name: string | null }>

	for (const { name: nm } of regionRows) {
		if (nm && HANGUL.test(nm)) {
			regionIdx.add(norm(nm))
			regionIdx.add(bare(nm))
		}
	}

	/**
	 * All localities within MATCH_RADIUS_KM, sorted nearest-first.
	 *
	 * Many Korean localities share a name across the country, so a Hangul name
	 * match must be constrained to nearby candidates.
	 * A global match followed by nearest-homonym selection can land hundreds of km away.
	 */
	const nearby = (lat: number, lon: number): Array<{ d: number; pid: number }> =>
		grid.nearby(lat, lon, MATCH_RADIUS_KM).map(({ d, entry }) => ({ d, pid: entry.pid }))

	// GeoNames postal KR: group by postcode (first row wins. Multi-row postcodes cluster tightly).
	const postal = new Map<string, [string, string, number, number]>()

	// `args.geonames` is a caller-supplied national dump, so the rows are streamed.
	for await (const row of geonamesPostalRows(args.geonames)) {
		if (!postal.has(row.postcode)) {
			postal.set(row.postcode, [row.placeName, row.admin1, row.latitude, row.longitude])
		}
	}

	let nameConfirmed = 0
	let provinceOk = 0
	let resolved = 0
	const rows: PostcodeLocalityInsertValues[] = []
	const total = postal.size
	const dists: number[] = []
	const p = (q: number): number => (dists.length ? pyRound(dists[Math.trunc(dists.length * q)]!, 3) : 0)

	{
		using kdb = new DatabaseClient<PostcodeLocalityDatabase>(args.output)

		await kdb.schema.dropTable("postcode_locality").ifExists().execute()

		await createPostcodeLocalityTable(kdb, { ifNotExists: false })

		for (const [pc, [place, admin1, lat, lon]] of postal) {
			const nb = nearby(lat, lon)

			if (!nb.length) continue

			resolved++
			const { d: d0, pid: pid0 } = nb[0]!
			dists.push(d0)

			if (regionIdx.has(norm(admin1)) || regionIdx.has(bare(admin1))) {
				provinceOk++
			}

			// Hangul name confirmation: a name-matched locality that is also nearby, the same
			// proximity-constrained match the JP builder uses. is_containing=1 marks the precise tier.
			const nameIDs = nameIdx.get(bare(place)) ?? new Set<number>()
			const named = nb.find(({ pid }) => nameIDs.has(pid))

			if (named) {
				nameConfirmed++
				rows.push([pc, "KR", named.pid, sprName.get(named.pid) ?? "", place, pyRound(named.d, 3), 1])

				if (named.pid !== pid0) {
					rows.push([pc, "KR", pid0, sprName.get(pid0) ?? "", place, pyRound(d0, 3), 0])
				}
			} else {
				rows.push([pc, "KR", pid0, sprName.get(pid0) ?? "", place, pyRound(d0, 3), 0])
			}
		}

		const insert = kdb.prepare(POSTCODE_LOCALITY_INSERT_SQL)
		kdb.exec("BEGIN")

		for (const r of rows) {
			insert.run(...r)
		}

		kdb.exec("COMMIT")

		await createPostcodeLocalityIndex(kdb, { ifNotExists: false })

		dists.sort((a, b) => a - b)

		await createPostcodeLocalityMetaTable(kdb, { ifNotExists: true })

		const meta: Array<[string, string]> = [
			["name", "mailwoman-postcode-locality-kr"],
			[
				"description",
				"KR postcode -> WOF locality via point-primary match (GeoNames postal point + Hangul name confirm)",
			],
			[
				"method",
				"point-primary: nearest WOF locality by GeoNames postal coordinate; Hangul (kor+und) name confirms the precise tier",
			],
			["source", "KR: GeoNames postal KR.txt + custom WOF admin-kr.db (whosonfirst-data-admin-kr); built from source"],
			["country", "KR"],
			["postcodes_total", String(total)],
			["postcodes_resolved", String(resolved)],
			["resolve_rate", `${((100 * resolved) / total).toFixed(1)}%`],
			["name_confirmed", String(nameConfirmed)],
			["name_confirm_rate", `${((100 * nameConfirmed) / total).toFixed(1)}%`],
			["province_match", `${((100 * provinceOk) / total).toFixed(1)}%`],
			["dist_km_p50", pyStrFloat(p(0.5))],
			["dist_km_p90", pyStrFloat(p(0.9))],
			["dist_km_p99", pyStrFloat(p(0.99))],
			[
				"ceiling_note",
				"name tier capped by WOF KR Hangul-name coverage; dominant miss = 구 urban districts (Juso source walled, #293 follow-up)",
			],
			["built_at", isoSecondsUTC()],
		]

		writeMetaRows(kdb, meta)

		finalizeSealedBuild(kdb, args.output)
	}

	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	await sealDatabase(args.output)

	console.log(
		`KR: ${total.toLocaleString("en-US")} postcodes, ${resolved.toLocaleString("en-US")} resolved ` +
			`(${((100 * resolved) / total).toFixed(1)}%), ${nameConfirmed.toLocaleString("en-US")} name-confirmed ` +
			`(${((100 * nameConfirmed) / total).toFixed(1)}%), province ${((100 * provinceOk) / total).toFixed(1)}%, ` +
			`dist p50/p90/p99 = ${pyStrFloat(p(0.5))}/${pyStrFloat(p(0.9))}/${pyStrFloat(p(0.99))} km, ` +
			`${rows.length.toLocaleString("en-US")} rows -> ${args.output}`
	)
}
