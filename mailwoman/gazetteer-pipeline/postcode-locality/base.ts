/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the postcode → containing-locality candidate table (#274), offline, FROM SOURCE.
 *
 *   The PIP-containment probe (#274 groundwork) showed coordinate-first resolution lifts German
 *   locality accuracy where name-match misses (Sachsen +22pp). This productizes it: for every
 *   postcode, point-in-polygon its centroid against the WOF locality polygons and record the
 *   containing locality (+ a few nearby ones for the abutting-postcode / soft-scoring candidate
 *   set), with WOF alt-name aliases.
 *
 *   The resolver consumes this at resolve time: postcode → candidate localities → soft-score by
 *   (postcode-proximity + name-match) → pick. It supplies the COORDINATE candidate the FTS
 *   name-match can't generate when a small town isn't well-indexed.
 *
 *   BUILD-FROM-SOURCE per the standing rule: locality polygons from the whosonfirst-data-admin-<cc>
 *   GeoJSON repos; postcode centroids from our own custom-built postalcode-intl.db (NOT a prebuilt
 *   dump).
 *
 *   Usage: node --experimental-strip-types scripts/build-postcode-locality.ts --country DE\
 *   --admin-repo $MAILWOMAN_DATA_ROOT/wof/repos/whosonfirst-data/whosonfirst-data-admin-de\
 *   --postcode-db $MAILWOMAN_DATA_ROOT/wof/postalcode-intl.db\
 *   --output $MAILWOMAN_DATA_ROOT/wof/postcode-locality-de.db\
 *   --radius-km 10 --max-candidates 4
 *
 *   PORT NOTE (from scripts/build-postcode-locality.py): faithful TypeScript port. Point-in-polygon
 *   REUSES the canonical even-odd ray cast `geometryContains` from
 *   `@mailwoman/resolver-wof-sqlite/geo` (byte-identical to the Python `in_geom`/`ray_in_ring`; the
 *   geo.ts header names this script as the in-sync sibling). Haversine is ported inline (asin form)
 *   to match the Python exactly. The output is written DIRECTLY to `--output` — NOT via a
 *   temp-then-move — because this builder is deliberately ACCUMULATIVE: `CREATE TABLE IF NOT
 *   EXISTS` + `DELETE FROM … WHERE country=?` lets one shared DB be filled DE, FR, … in successive
 *   `--country` runs (a temp-build would wipe prior countries' rows).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { sealDatabase } from "@mailwoman/core/utils"
import { geometryContains, type GeojsonGeometry } from "@mailwoman/resolver-wof-sqlite/geo"

/** Increment a non-negative decimal-digit string, propagating the carry (e.g. "999" → "1000"). */
function incDecimalString(s: string): string {
	const a = s.split("")
	let i = a.length - 1

	for (; i >= 0; i--) {
		if (a[i] === "9") {
			a[i] = "0"
		} else {
			a[i] = String(Number(a[i]) + 1)
			break
		}
	}

	if (i < 0) {
		a.unshift("1")
	}

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

	if (first > 5) {
		roundUp = true
	} else if (first === 5) {
		if (/[1-9]/.test(rest.slice(1))) {
			roundUp = true
		} else {
			// exact half → round to even
			const lastKept = keep.length ? keep.charCodeAt(keep.length - 1) - 48 : Number(intPart) % 10
			roundUp = lastKept % 2 === 1
		}
	}
	let combined = intPart + keep

	if (roundUp) {
		combined = incDecimalString(combined)
	}
	const num = Number(combined) / 10 ** nd

	return neg ? -num : num
}

/** Python `math.radians`. */
function toRad(deg: number): number {
	return (deg * Math.PI) / 180
}

/** Haversine great-circle distance in km — ported from the Python `haversine` (asin form). */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371.0
	const p1 = toRad(lat1)
	const p2 = toRad(lat2)
	const dp = toRad(lat2 - lat1)
	const dl = toRad(lon2 - lon1)
	const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2

	return 2 * R * Math.asin(Math.sqrt(a))
}

const ALT_NAME_KEYS = new Set(["wof:label"]) // plus name:* / label:* props, gathered below

/** WOF alt-name aliases from name:* / label:* props (+ `wof:label`), minus the canonical. */
function aliasesFor(props: Record<string, unknown>, canonical: string): string[] {
	const out = new Set<string>()

	for (const [k, v] of Object.entries(props)) {
		const isNameLabel = k.startsWith("name:") || k.startsWith("label:")

		if ((isNameLabel || ALT_NAME_KEYS.has(k)) && typeof v === "string") {
			out.add(v)
		} else if (isNameLabel && Array.isArray(v)) {
			for (const x of v)
				if (typeof x === "string") {
					out.add(x)
				}
		}
	}
	out.delete(canonical)

	return [...out].sort()
}

/** Push `v` into the array bucket at `k`, creating it on first touch (Python `defaultdict(list)`). */
function pushTo<V>(m: Map<string, V[]>, k: string, v: V): void {
	const a = m.get(k)

	if (a) {
		a.push(v)
	} else {
		m.set(k, [v])
	}
}

/** UTC ISO-8601 to the second, matching Python `datetime.now(utc).isoformat(timespec="seconds")`. */
function isoSeconds(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

interface Locality {
	id: number
	name: string
	aliases: string[]
	clat: number
	clon: number
	bbox: [number, number, number, number]
	geom: GeojsonGeometry
}

export interface PostcodeLocalityBaseOptions {
	country?: string
	adminRepo?: string
	postcodeDB?: string
	output: string
	radiusKm: number
	maxCandidates: number
	finalize: boolean
}

/**
 * Freeze the accumulated table into a self-contained, read-only, distributable sqlite asset (the same shape as our
 * other WOF tables): a provenance/license `meta` table, query-planner stats, an integrity check, a rollback (non-WAL)
 * journal mode so there's no sidecar, and a VACUUM to compact.
 */
export async function finalizePostcodeLocality(output: string): Promise<void> {
	const db = new DatabaseSync(output)
	const counts = db
		.prepare(
			"SELECT country AS country, COUNT(*) AS n, SUM(is_containing) AS con FROM postcode_locality GROUP BY country ORDER BY country"
		)
		.all() as Array<{ country: string; n: number; con: number | null }>

	// Ordered (SQL ORDER BY country) summary of {rows, containing}.
	const summary = new Map<string, { rows: number; containing: number }>()

	for (const c of counts) {
		summary.set(c.country, { rows: Number(c.n), containing: Number(c.con || 0) })
	}

	// `countries` meta value: Python `json.dumps(summary, sort_keys=True)` → sorted keys, inner keys
	// alphabetical (containing < rows), separators ", " / ": ".
	const countriesJson =
		"{" +
		[...summary.keys()]
			.sort()
			.map((c) => {
				const s = summary.get(c)!

				return `${JSON.stringify(c)}: {"containing": ${s.containing}, "rows": ${s.rows}}`
			})
			.join(", ") +
		"}"

	const kdb = new DatabaseClient({ database: db })
	await kdb.schema
		.createTable("meta")
		.ifNotExists()
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text")
		.execute()

	const meta: Array<[string, string]> = [
		["name", "mailwoman-postcode-locality"],
		["description", "postcode → containing + nearby WOF locality candidates (coordinate-first resolution)"],
		["schema_version", "1"],
		["built_at", isoSeconds()],
		[
			"source",
			"Who's On First (whosonfirst.org) — admin locality polygons + postalcode centroids; built from source GeoJSON, not a prebuilt dump",
		],
		["license", "CC-BY 4.0 (Who's On First) — attribution required on redistribution"],
		["attribution", "Contains data from Who's On First, © Who's On First contributors, CC-BY 4.0"],
		[
			"method",
			"point-in-polygon of each postcode centroid against WOF locality polygons (+ a ~10km nearby candidate set with alt-name aliases)",
		],
		["countries", countriesJson],
	]
	const insMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")

	for (const [k, v] of meta) {
		insMeta.run(k, v)
	}

	db.exec("PRAGMA journal_mode = DELETE") // no -wal/-shm sidecar; the .db is self-contained
	db.exec("ANALYZE")
	const ok = (db.prepare("PRAGMA integrity_check").get() as Record<string, string>)["integrity_check"]

	if (ok !== "ok") {
		console.error(`integrity_check failed: ${ok}`)
		process.exit(1)
	}
	db.exec("VACUUM")
	db.close()

	// Python prints the dict repr (insertion order rows→containing, single quotes).
	const summaryRepr =
		"{" +
		[...summary.entries()].map(([c, s]) => `'${c}': {'rows': ${s.rows}, 'containing': ${s.containing}}`).join(", ") +
		"}"
	console.log(`finalized ${output}: integrity=ok, countries=${summaryRepr}`)
}

/** Recursively collect every `.geojson` file under `dir` (Python's recursive `glob` over `data`). */
function geojsonFiles(dir: string): string[] {
	if (!existsSync(dir)) return []

	return (readdirSync(dir, { recursive: true }) as string[])
		.filter((p) => p.endsWith(".geojson"))
		.map((p) => join(dir, p))
}

export async function buildPostcodeLocalityBase(args: PostcodeLocalityBaseOptions): Promise<void> {
	const { country, adminRepo, postcodeDB, output, radiusKm, maxCandidates } = args

	console.log(`loading ${country} locality polygons from source GeoJSON…`)
	const locs: Locality[] = []

	for (const fp of geojsonFiles(join(adminRepo!, "data"))) {
		try {
			const g = JSON.parse(readFileSync(fp, "utf8"))
			const p: Record<string, unknown> = g.properties ?? {}

			if (p["wof:placetype"] !== "locality" || (p["mz:is_current"] ?? 1) === 0) continue
			const geom = g.geometry as GeojsonGeometry | undefined

			if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue
			const xs: number[] = []
			const ys: number[] = []
			const walk = (c: unknown): void => {
				if (typeof (c as unknown[])[0] === "number") {
					const pos = c as number[]
					xs.push(pos[0]!)
					ys.push(pos[1]!)
				} else {
					for (const cc of c as unknown[]) {
						walk(cc)
					}
				}
			}
			walk((geom as { coordinates: unknown }).coordinates)
			const name = (p["wof:name"] as string) ?? ""
			const lblLat = p["lbl:latitude"]
			const lblLon = p["lbl:longitude"]
			const clat = typeof lblLat === "number" ? lblLat : (Math.min(...ys) + Math.max(...ys)) / 2
			const clon = typeof lblLon === "number" ? lblLon : (Math.min(...xs) + Math.max(...xs)) / 2
			locs.push({
				id: Number(p["wof:id"]),
				name,
				aliases: aliasesFor(p, name),
				clat,
				clon,
				bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
				geom,
			})
		} catch {
			// ignore unreadable / malformed files (Python's bare except: pass)
		}
	}
	console.log(`  ${locs.length} localities`)

	// Two 0.1°-cell (~11km) grid indexes. `grid` (by centroid) drives the radius candidate set; `bgrid`
	// (by bbox-spanned cells — a locality is registered in every cell its bounding box overlaps) drives
	// the containing-PIP, so it checks only the localities whose bbox could cover the point instead of a
	// linear scan over all of them. At GB scale (2.7M postcodes × 11.7K localities) that's the
	// difference between minutes and ~an hour.
	const grid = new Map<string, number[]>()
	const bgrid = new Map<string, number[]>()

	for (let idx = 0; idx < locs.length; idx++) {
		const l = locs[idx]!
		pushTo(grid, `${pyRound(l.clon * 10)}|${pyRound(l.clat * 10)}`, idx)
		const [minx, miny, maxx, maxy] = l.bbox

		for (let cx = Math.floor(minx * 10); cx <= Math.floor(maxx * 10); cx++) {
			for (let cy = Math.floor(miny * 10); cy <= Math.floor(maxy * 10); cy++) {
				pushTo(bgrid, `${cx}|${cy}`, idx)
			}
		}
	}

	const con = new DatabaseSync(postcodeDB!)
	const postcodes = con
		.prepare("SELECT name, latitude, longitude FROM spr WHERE country=? AND placetype='postalcode' AND is_current!=0")
		.all(country!) as Array<{ name: string; latitude: number | null; longitude: number | null }>
	con.close()
	console.log(`  ${postcodes.length} ${country} postcode centroids`)

	const out = new DatabaseSync(output)
	// Accumulate per country into one shared DB (the resolver attaches a SINGLE postcode_locality shard
	// and country-filters at query time). CREATE-IF-NOT-EXISTS + DELETE-this-country makes each --country
	// run idempotent, so `--output postcode-locality-intl.db` can be filled DE, FR, … in turn.
	const kdb = new DatabaseClient({ database: out })
	await kdb.schema
		.createTable("postcode_locality")
		.ifNotExists()
		.addColumn("postcode", "text", (c) => c.notNull())
		.addColumn("country", "text", (c) => c.notNull())
		.addColumn("locality_id", "integer", (c) => c.notNull())
		.addColumn("locality_name", "text", (c) => c.notNull())
		.addColumn("aliases", "text")
		.addColumn("distance_km", "real", (c) => c.notNull())
		.addColumn("is_containing", "integer", (c) => c.notNull())
		.execute()
	out.prepare("DELETE FROM postcode_locality WHERE country = ?").run(country!)

	const insert = out.prepare("INSERT INTO postcode_locality VALUES (?,?,?,?,?,?,?)")
	let rows = 0
	let nContained = 0
	out.exec("BEGIN")

	for (const pcRow of postcodes) {
		const pc = pcRow.name
		const plat = pcRow.latitude
		const plon = pcRow.longitude

		if (plat == null || plon == null) continue

		// containing locality via bbox-grid-prefiltered PIP (only localities whose bbox spans this cell)
		let containingIdx: number | null = null

		for (const idx of bgrid.get(`${Math.floor(plon * 10)}|${Math.floor(plat * 10)}`) ?? []) {
			const l = locs[idx]!
			const [minx, miny, maxx, maxy] = l.bbox

			if (
				minx <= plon &&
				plon <= maxx &&
				miny <= plat &&
				plat <= maxy &&
				geometryContains(l.geom, plon, plat) === true
			) {
				containingIdx = idx
				break
			}
		}

		// nearby candidates within radius (grid-limited) for the soft-scoring candidate set + abutting case
		const cand: Array<{ d: number; idx: number }> = []
		const gx = pyRound(plon * 10)
		const gy = pyRound(plat * 10)

		for (const dx of [-1, 0, 1]) {
			for (const dy of [-1, 0, 1]) {
				for (const idx of grid.get(`${gx + dx}|${gy + dy}`) ?? []) {
					const d = haversineKm(plat, plon, locs[idx]!.clat, locs[idx]!.clon)

					if (d <= radiusKm) {
						cand.push({ d, idx })
					}
				}
			}
		}
		cand.sort((a, b) => a.d - b.d || a.idx - b.idx)

		const chosen: Array<{ d: number; idx: number; isc: number }> = []

		if (containingIdx !== null) {
			chosen.push({ d: 0.0, idx: containingIdx, isc: 1 })
			nContained++
		}

		for (const { d, idx } of cand) {
			if (idx === containingIdx) continue

			if (chosen.filter((c) => c.isc === 0).length >= maxCandidates) break
			chosen.push({ d, idx, isc: 0 })
		}

		for (const { d, idx, isc } of chosen) {
			const l = locs[idx]!
			insert.run(pc, country!, l.id, l.name, l.aliases.join("|"), pyRound(d, 3), isc)
			rows++
		}
	}
	out.exec("COMMIT")

	await kdb.schema
		.createIndex("postcode_locality_by_pc")
		.ifNotExists()
		.on("postcode_locality")
		.columns(["postcode", "country"])
		.execute()
	console.log(
		`  wrote ${rows} rows (${nContained}/${postcodes.length} postcodes have a containing locality) → ${output}`
	)
	out.close()
	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	sealDatabase(output)
}
