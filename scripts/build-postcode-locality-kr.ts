/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a KR postcode → WOF locality table by POINT-PRIMARY match (#293, Direction E / CJK arena).
 *
 *   This is the South-Korea sibling of `build-postcode-locality-cjk.ts` (Japan). It emits the SAME
 *   `postcode_locality` table, so the existing `postcode_area_resolution` resolver strategy
 *   consumes it unchanged — that is the whole point of the CJK arena: ONE strategy, many builds.
 *   But KR's data shape is the INVERSE of Japan's, so the build is inverted too:
 *
 *   Japan (name-primary): postcode --KEN_ALL--> municipality NAME (romaji) ; GeoNames --> point ;
 *   match NAME (+ proximity tiebreak) against romanized `spr.name`. -> 94.9% Korea (point-primary):
 *   GeoNames postal file ALREADY carries postcode -> (place_name, admin1, lat, lon) in one source.
 *   `spr.name` is romanized, but the WOF `names` table carries Hangul (`kor` + Hangul-bearing
 *   `und`) variants. So we resolve by NEAREST locality POINT (always available, sub-km dense) and
 *   use the Hangul name as an authoritative CONFIRMATION signal where it exists.
 *
 *   Tiering (same schema/semantics as the JP builder):
 *
 *   - Is_containing=1 : Hangul name-confirmed locality (the precise tier; correct granularity)
 *   - Is_containing=0 : point-nearest fallback (province + coordinate right; the unit may be finer)
 *
 *   The province (admin1 -> WOF region, Hangul-exact, 100%) is recorded in `meta` as the reliable
 *   coarse anchor. Build-from-source: GeoNames postal KR + our custom WOF admin-kr.db (built from
 *   the whosonfirst-data-admin-kr repo, never a prebuilt geocode.earth dump).
 *
 *   Usage: node --experimental-strip-types scripts/build-postcode-locality-kr.ts\
 *   --geonames $MAILWOMAN_DATA_ROOT/geonames/KR.txt\
 *   --admin-db $MAILWOMAN_DATA_ROOT/wof/dbs-per-country/admin-kr.db\
 *   --output $MAILWOMAN_DATA_ROOT/wof/postcode-locality-kr.db
 *
 *   PORT NOTE (from scripts/build-postcode-locality-kr.py): faithful TypeScript port. No polygons, so
 *   no PIP. Matching is point-nearest (haversine ported inline, asin form, to match Python exactly)
 *   with proximity-constrained Hangul name confirmation. The output is written DIRECTLY to
 *   `--output` (the Python `DROP TABLE …` then `CREATE TABLE` full single-country rebuild),
 *   preserving behavior.
 */

import { readFileSync, realpathSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { DatabaseClient } from "@mailwoman/core/kysley/client"

const MATCH_RADIUS_KM = 20.0 // KR postcode points sit p50 ~1 km from the nearest locality; 20 km is a safe net
const HANGUL = /[가-힣]/
// Korean administrative suffixes, stripped to a bare stem so 추자면 ~ 추자, 강남구 ~ 강남, etc.
const SUFFIX = /(특별자치도|특별자치시|광역시|특별시|면|동|읍|시|군|구|리)$/

/** Increment a non-negative decimal-digit string, propagating the carry (e.g. "999" → "1000"). */
function incDecimalString(s: string): string {
	const a = s.split("")
	let i = a.length - 1

	for (; i >= 0; i--) {
		if (a[i] === "9") a[i] = "0"
		else {
			a[i] = String(Number(a[i]) + 1)
			break
		}
	}

	if (i < 0) a.unshift("1")

	return a.join("")
}

/**
 * Python `round()` — correctly-rounded, round-half-to-EVEN. Works off the double's EXACT (terminating) decimal
 * expansion via `toFixed(80)`, so it matches Python both on ordinary values (where a naïve `x * 10**nd` would diverge
 * by a ULP) and on exact half-way ties like `40.890625` → `40.89062` (where `toFixed(nd)` rounds half-UP and would
 * diverge). `nd === 0` keeps a fast half-even path on the double.
 */
function pyRound(x: number, nd: number = 0): number {
	if (!Number.isFinite(x)) return x

	if (nd === 0) {
		const floor = Math.floor(x)
		const diff = x - floor

		if (diff < 0.5) return floor

		if (diff > 0.5) return floor + 1

		return floor % 2 === 0 ? floor : floor + 1
	}
	const neg = x < 0
	const digits = Math.abs(x).toFixed(20) // exact expansion for any coord/distance-range double
	const dot = digits.indexOf(".")
	const intPart = digits.slice(0, dot)
	const frac = digits.slice(dot + 1)
	const keep = frac.slice(0, nd)
	const rest = frac.slice(nd)
	let roundUp = false
	const first = rest.charCodeAt(0) - 48

	if (first > 5) roundUp = true
	else if (first === 5) {
		if (/[1-9]/.test(rest.slice(1))) roundUp = true
		else {
			// exact half → round to even
			const lastKept = keep.length ? keep.charCodeAt(keep.length - 1) - 48 : Number(intPart) % 10
			roundUp = lastKept % 2 === 1
		}
	}
	let combined = intPart + keep

	if (roundUp) combined = incDecimalString(combined)
	const num = Number(combined) / 10 ** nd

	return neg ? -num : num
}

/** Python `str(float)` — integer-valued floats render with a trailing `.0` (e.g. `1.0`, `0.0`). */
function pyStrFloat(x: number): string {
	return Number.isInteger(x) ? `${x}.0` : String(x)
}

/** Python `float()`: trimmed-empty / non-numeric → null (the build's try/except skip). */
function pyFloat(s: string | undefined): number | null {
	if (s === undefined) return null
	const t = s.trim()

	if (t === "") return null
	const n = Number(t)

	return Number.isNaN(n) ? null : n
}

function norm(s: string | null | undefined): string {
	return (s || "").normalize("NFKC").replace(/[\s-]/g, "").toLowerCase()
}

function bare(s: string | null | undefined): string {
	return norm(s).replace(SUFFIX, "")
}

/** Python `math.radians`. */
function toRad(deg: number): number {
	return (deg * Math.PI) / 180
}

/** Haversine distance in km, ported from the Python `haversine(a, b, c, d)` (asin form). */
function haversineKm(aLat: number, bLon: number, cLat: number, dLon: number): number {
	const R = 6371.0
	const p1 = toRad(aLat)
	const p2 = toRad(cLat)
	const dp = toRad(cLat - aLat)
	const dl = toRad(dLon - bLon)

	return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2))
}

/** UTC ISO-8601 to the second, matching Python `datetime.now(utc).isoformat(timespec="seconds")`. */
function isoSeconds(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

interface Args {
	geonames: string
	adminDb: string
	output: string
}

function parseCliArgs(): Args {
	const { values } = parseArgs({
		options: {
			geonames: { type: "string" },
			"admin-db": { type: "string" },
			output: { type: "string" },
		},
	})

	if (!values.geonames || !values["admin-db"] || !values.output) {
		console.error("Usage: build-postcode-locality-kr.ts --geonames <KR.txt> --admin-db <admin-kr.db> --output <db>")
		process.exit(2)
	}

	return { geonames: values.geonames, adminDb: values["admin-db"], output: values.output }
}

async function main(): Promise<void> {
	const args = parseCliArgs()

	const admin = new DatabaseSync(args.adminDb)

	// Locality point index + id->name (romanized spr.name, for the human-readable row label).
	const loc = admin
		.prepare("SELECT id,name,latitude,longitude FROM spr WHERE placetype='locality' AND (latitude!=0 OR longitude!=0)")
		.all() as Array<{ id: number; name: string; latitude: number; longitude: number }>
	const xy = new Map<number, [number, number]>()
	const sprName = new Map<number, string>()
	const grid = new Map<string, Array<{ pid: number; la: number; lo: number }>>()

	for (const { id, name, latitude, longitude } of loc) {
		xy.set(id, [latitude, longitude])
		sprName.set(id, name)
		const key = `${pyRound(longitude * 2)}|${pyRound(latitude * 2)}`
		const bucket = grid.get(key)
		const entry = { pid: id, la: latitude, lo: longitude }

		if (bucket) bucket.push(entry)
		else grid.set(key, [entry])
	}

	// Hangul locality-name index (kor + Hangul-bearing und): bare-stem -> set(ids).
	const nameIdx = new Map<string, Set<number>>()

	for (const lang of ["kor", "und"]) {
		const named = admin
			.prepare("SELECT id,name FROM names WHERE language=? AND placetype='locality'")
			.all(lang) as Array<{ id: number; name: string | null }>

		for (const { id: nid, name: nm } of named) {
			if (xy.has(nid) && nm && HANGUL.test(nm)) {
				const key = bare(nm)
				const set = nameIdx.get(key)

				if (set) set.add(nid)
				else nameIdx.set(key, new Set([nid]))
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
	admin.close()

	/**
	 * All localities within MATCH_RADIUS_KM, sorted nearest-first. Korean place names repeat heavily across the country
	 * (homonymous villages), so a Hangul name-match MUST be constrained to nearby candidates — matching globally then
	 * taking the nearest homonym lands hundreds of km away.
	 */
	const nearby = (lat: number, lon: number): Array<{ d: number; pid: number }> => {
		const cx = pyRound(lon * 2)
		const cy = pyRound(lat * 2)
		const out: Array<{ d: number; pid: number }> = []

		for (const dx of [-1, 0, 1]) {
			for (const dy of [-1, 0, 1]) {
				for (const { pid, la, lo } of grid.get(`${cx + dx}|${cy + dy}`) ?? []) {
					const d = haversineKm(lat, lon, la, lo)

					if (d <= MATCH_RADIUS_KM) out.push({ d, pid })
				}
			}
		}
		out.sort((a, b) => a.d - b.d || a.pid - b.pid)

		return out
	}

	// GeoNames postal KR: group by postcode (first row wins; multi-row postcodes cluster tightly).
	const postal = new Map<string, [string, string, number, number]>()

	for (const line of readFileSync(args.geonames, "utf8").split("\n")) {
		const f = line.replace(/\n$/, "").split("\t")

		if (f.length > 10 && f[1]) {
			const lat = pyFloat(f[9])
			const lon = pyFloat(f[10])

			if (lat === null || lon === null) continue

			// pc -> (place, admin1, lat, lon)
			if (!postal.has(f[1]!)) postal.set(f[1]!, [f[2]!, f[3]!, lat, lon])
		}
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
	let resolved = 0
	let nameConfirmed = 0
	let provinceOk = 0
	const dists: number[] = []

	for (const [pc, [place, admin1, lat, lon]] of postal) {
		const nb = nearby(lat, lon)

		if (nb.length === 0) continue
		resolved++
		const { d: d0, pid: pid0 } = nb[0]! // point-nearest
		dists.push(d0)

		if (regionIdx.has(norm(admin1)) || regionIdx.has(bare(admin1))) provinceOk++
		// Hangul name confirmation: a name-matched locality that is ALSO nearby (two signals agreeing —
		// the same proximity-constrained match the JP builder uses). is_containing=1 marks the precise tier.
		const nameIds = nameIdx.get(bare(place)) ?? new Set<number>()
		const named = nb.find(({ pid }) => nameIds.has(pid))

		if (named) {
			nameConfirmed++
			rows.push([pc, "KR", named.pid, sprName.get(named.pid) ?? "", place, pyRound(named.d, 3), 1])

			if (named.pid !== pid0) {
				// keep the point-nearest as a weak alternate
				rows.push([pc, "KR", pid0, sprName.get(pid0) ?? "", place, pyRound(d0, 3), 0])
			}
		} else {
			rows.push([pc, "KR", pid0, sprName.get(pid0) ?? "", place, pyRound(d0, 3), 0])
		}
	}

	const insert = db.prepare("INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)")
	db.exec("BEGIN")

	for (const r of rows) insert.run(...r)
	db.exec("COMMIT")

	await kdb.schema
		.createIndex("postcode_locality_by_pc")
		.on("postcode_locality")
		.columns(["postcode", "country"])
		.execute()

	dists.sort((a, b) => a - b)
	const p = (q: number): number => (dists.length ? pyRound(dists[Math.trunc(dists.length * q)]!, 3) : 0.0)
	const total = postal.size

	await kdb.schema
		.createTable("meta")
		.ifNotExists()
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text")
		.execute()
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
		["built_at", isoSeconds()],
	]
	const insMeta = db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)")

	for (const [k, v] of meta) insMeta.run(k, v)

	db.exec("PRAGMA journal_mode=DELETE")
	db.exec("ANALYZE")
	const ok = (db.prepare("PRAGMA integrity_check").get() as Record<string, string>)["integrity_check"]

	if (ok !== "ok") {
		console.error(`integrity_check failed: ${ok}`)
		process.exit(1)
	}
	db.exec("VACUUM")
	db.close()

	console.log(
		`KR: ${total.toLocaleString("en-US")} postcodes, ${resolved.toLocaleString("en-US")} resolved ` +
			`(${((100 * resolved) / total).toFixed(1)}%), ${nameConfirmed.toLocaleString("en-US")} name-confirmed ` +
			`(${((100 * nameConfirmed) / total).toFixed(1)}%), province ${((100 * provinceOk) / total).toFixed(1)}%, ` +
			`dist p50/p90/p99 = ${pyStrFloat(p(0.5))}/${pyStrFloat(p(0.9))}/${pyStrFloat(p(0.99))} km, ` +
			`${rows.length.toLocaleString("en-US")} rows -> ${args.output}`
	)
}

// Run main() only when invoked directly (the import-safe equivalent of Python's `if __name__ ==
// "__main__"`), so importing this module evaluates it without running the build.
const selfPath = realpathSync(fileURLToPath(import.meta.url))
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : ""

if (entryPath && entryPath === selfPath) {
	await main()
}
