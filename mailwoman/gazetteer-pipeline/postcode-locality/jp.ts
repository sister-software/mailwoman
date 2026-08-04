/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a CJK postcode → WOF locality table by AUTHORITATIVE NAME-MATCH (#292, Direction E).
 *
 *   WOF admin geometry in CJK (JP/KR/TW) is point-based at the municipality/locality level — there
 *   are no municipality POLYGONS — so the European point-in-polygon coordinate-first build
 *   (build-postcode-locality.ts) is structurally inapplicable. This is the CJK substitute:
 *
 *   Postcode --(national postal authority)--> municipality NAME (romanized) postcode --(GeoNames)-->
 *   point municipality name + point --(cross-placetype name+proximity match)--> WOF place id
 *
 *   The match searches ALL the municipality-ish WOF placetypes (locality + county + localadmin +
 *   borough), because CJK municipalities are split across them (regular cities → locality, wards →
 *   county/localadmin, Tokyo special wards → borough). Matching a single placetype was the 52/60%
 *   trap; cross-placetype is 94.3%.
 *
 *   Output is the standard `postcode_locality` table, so the existing `postcode_area_resolution`
 *   resolver strategy consumes it unchanged (is_containing=1 for the name-matched municipality).
 *   Build-from-source: the authoritative names come from the national postal file (JP = KEN_ALL,
 *   Japan Post), points from GeoNames (already an in-project source for DE/ES/IT/NL); both are
 *   source material, not prebuilt dumps.
 *
 *   Usage (JP): node scripts/build-postcode-locality-cjk.ts --country JP\
 *   --postal-names $MAILWOMAN_DATA_ROOT/KEN_ALL_ROME/KEN_ALL_ROME.CSV\
 *   --geonames $MAILWOMAN_DATA_ROOT/geonames/JP.txt\
 *   --admin-db $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db\
 *   --output $MAILWOMAN_DATA_ROOT/wof/postcode-locality-jp.db
 *
 *   PORT NOTE (from scripts/build-postcode-locality-cjk.py): faithful TypeScript port. No polygons
 *   here, so there is no PIP — matching is name + haversine proximity (haversine ported inline,
 *   asin form, to match Python exactly). The output is written DIRECTLY to `--output` (the Python
 *   `DROP TABLE …` + `CREATE TABLE` full single-country rebuild), preserving the original's
 *   behavior.
 */

import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { pyFloat, pyRound, sealDatabase } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"
import { TSVSpliterator } from "spliterator"

/**
 * Digit at which a fractional remainder is exactly half. Above it the value rounds up; at it the tie is broken toward
 * even, which is what keeps repeated centroid rounding unbiased.
 */
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
 * The WOF place name (suffix-stripped) appears as a token in the authoritative municipality string (which carries
 * city+ward, e.g. 'SAPPORO SHI CHUO KU').
 */
function nameMatches(wofName: string, postalMuni: string): boolean {
	const nw = norm(wofName).replace(SUFFIX, "")

	return nw.length >= 2 && norm(postalMuni).includes(nw)
}

/**
 * Python `math.radians`.
 */
function toRad(deg: number): number {
	return (deg * Math.PI) / 180
}

/**
 * JP KEN_ALL_ROME (CP932): col0=postcode(7-digit), col5=municipality romaji → {NNN-NNNN: muni}.
 */
function loadKenall(path: string): Map<string, string> {
	const out = new Map<string, string>()
	const text = new TextDecoder("shift_jis").decode(readFileSync(path))

	for (const raw of text.split("\n")) {
		const line = raw.replace(/[\r\n]+$/, "")
		const f = line.split(",").map((c) => c.replace(/^"+/, "").replace(/"+$/, ""))

		if (f.length >= MIN_KEN_ALL_COLUMNS && f[0]!.length === JIS_CODE_LENGTH && /^[0-9]+$/.test(f[0]!)) {
			out.set(`${f[0]!.slice(0, 3)}-${f[0]!.slice(3)}`, f[5]!)
		}
	}

	return out
}

/**
 * GeoNames postal file → {postcode (NNN-NNNN): [lat, lon]} (last row for a postcode wins).
 */
async function loadGeonamesPoints(path: string): Promise<Map<string, [number, number]>> {
	const out = new Map<string, [number, number]>()

	// Streamed — `path` is a caller-supplied national dump (JP's is 12 MB). `header: false` is
	// load-bearing: the GeoNames postal dump is headerless, so row 1 would be read as column names.
	for await (const f of TSVSpliterator.fromAsync(path, { header: false })) {
		if (f.length > 10 && f[1]) {
			const lat = pyFloat(f[9])
			const lon = pyFloat(f[10])

			if (lat === null || lon === null) continue
			out.set(f[1]!, [lat, lon])
		}
	}

	return out
}

/**
 * UTC ISO-8601 to the second, matching Python `datetime.now(utc).isoformat(timespec="seconds")`.
 */
function isoSeconds(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

export interface PostcodeLocalityJPOptions {
	country: string
	postalNames: string
	geonames: string
	adminDb: string
	output: string
}

export async function buildPostcodeLocalityJP(args: PostcodeLocalityJPOptions): Promise<void> {
	const postal = args.country === "JP" ? loadKenall(args.postalNames) : new Map<string, string>()

	if (!postal.size) {
		console.error(`no postal names loaded for ${args.country} (only KEN_ALL/JP wired so far)`)

		process.exit(1)
	}

	const points = await loadGeonamesPoints(args.geonames)

	const admin = new DatabaseSync(args.adminDb)
	const ph = PLACETYPES.map(() => "?").join(",")

	const places = admin
		.prepare(
			`SELECT id,name,latitude,longitude FROM spr WHERE country=? AND placetype IN (${ph}) ` +
				`AND latitude IS NOT NULL AND NOT (latitude=0 AND longitude=0)`
		)
		.all(args.country, ...PLACETYPES) as Array<{ id: number; name: string; latitude: number; longitude: number }>

	admin.close()

	const grid = new Map<string, Array<{ pid: number; nm: string; la: number; lo: number }>>()

	for (const { id, name, latitude, longitude } of places) {
		const key = `${pyRound(longitude * 2)}|${pyRound(latitude * 2)}`
		const bucket = grid.get(key)
		const entry = { pid: id, nm: name, la: latitude, lo: longitude }

		if (bucket) {
			bucket.push(entry)
		} else {
			grid.set(key, [entry])
		}
	}

	const nearby = (lat: number, lon: number): Array<{ d: number; pid: number; nm: string }> => {
		const cx = pyRound(lon * 2)
		const cy = pyRound(lat * 2)
		const out: Array<{ d: number; pid: number; nm: string }> = []

		for (const dx of [-1, 0, 1]) {
			for (const dy of [-1, 0, 1]) {
				for (const { pid, nm, la, lo } of grid.get(`${cx + dx}|${cy + dy}`) ?? []) {
					const d = haversineKm(lat, lon, la, lo)

					if (d <= MATCH_RADIUS_KM) {
						out.push({ d, pid, nm })
					}
				}
			}
		}

		out.sort((a, b) => a.d - b.d || a.pid - b.pid || (a.nm < b.nm ? -1 : a.nm > b.nm ? 1 : 0))

		return out
	}

	const db = new DatabaseSync(args.output)
	const kdb = new DatabaseClient({ database: db })
	await kdb.schema.dropTable("postcode_locality").ifExists().execute()

	await kdb.schema
		.createTable("postcode_locality")
		.addColumn("postcode", "text", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("locality_id", "integer", (c) => c.notNull())
		.addColumn("locality_name", "text", (c) => c.notNull())
		.addColumn("aliases", "text")
		.addColumn("distance_km", "real", (c) => c.notNull())
		.addColumn("is_containing", "integer", (c) => c.notNull())
		.execute()

	const rows: Array<[string, string, number, string, string, number, number]> = []
	let matched = 0
	const keys = [...postal.keys()].filter((k) => points.has(k))

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
			// no authoritative name match nearby → nearest place as a weak candidate
			const c0 = cands[0]!
			rows.push([pc, args.country, c0.pid, c0.nm, muni, pyRound(c0.d, 3), 0])
		}
	}

	const insert = db.prepare("INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)")
	db.exec("BEGIN")

	for (const r of rows) {
		insert.run(...r)
	}

	db.exec("COMMIT")

	await kdb.schema
		.createIndex("postcode_locality_by_pc")
		.on("postcode_locality")
		.columns(["postcode", "country"])
		.execute()

	await kdb.schema
		.createTable("meta")
		.ifNotExists()
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text")
		.execute()

	const matchRate = `${((100 * matched) / keys.length).toFixed(1)}%`

	const meta: Array<[string, string]> = [
		["name", "mailwoman-postcode-locality-cjk"],
		["description", "CJK postcode -> WOF locality via authoritative-name + proximity match (no polygons)"],
		["method", "national-postal-authority municipality NAME + GeoNames point -> cross-placetype WOF match"],
		["source", `${args.country}: KEN_ALL_ROME (Japan Post, romanized) + GeoNames postal points; built from source`],
		["country", args.country],
		["postcodes_total", String(keys.length)],
		["postcodes_matched", String(matched)],
		["match_rate", matchRate],
		["built_at", isoSeconds()],
	]

	const insMeta = db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")

	for (const [k, v] of meta) {
		insMeta.run(k, v)
	}

	db.exec("PRAGMA journal_mode=DELETE")
	db.exec("ANALYZE")
	const ok = (db.prepare("PRAGMA integrity_check").get() as Record<string, string>)["integrity_check"]

	if (ok !== "ok") {
		console.error(`integrity_check failed: ${ok}`)

		process.exit(1)
	}

	db.exec("VACUUM")
	db.close()
	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	sealDatabase(args.output)

	console.log(
		`${args.country}: ${keys.length.toLocaleString("en-US")} postcodes (KEN_ALL∩GeoNames), ` +
			`${matched.toLocaleString("en-US")} name-matched (${matchRate}), ` +
			`${rows.length.toLocaleString("en-US")} rows -> ${args.output}`
	)
}
