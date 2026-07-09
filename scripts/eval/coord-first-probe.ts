/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coordinate-first ceiling probe (#274) — does PIP'ing the postcode centroid beat name-match
 *   resolution?
 *
 *   The PIP-containment metric (#273) showed the German gap is real (Sachsen 54%), and that the
 *   postcode anchor already places addresses at ~1.3km. This probe tests the coordinate-first
 *   hypothesis directly: take each address's POSTCODE CENTROID, point-in-polygon it against the DE
 *   locality polygons, and ask — does the gold OA point fall inside the locality the centroid
 *   landed in? If that beats the current 54% Sachsen containment, the postcode->locality candidate
 *   table is the German fix.
 *
 *   Build-from-SOURCE per the standing rule: locality polygons from the whosonfirst-data-admin-de
 *   GeoJSON repo; postcode centroids from our own custom-built postalcode-intl.db (NOT a prebuilt
 *   WOF dump).
 *
 *   Usage: node scripts/eval/coord-first-probe.ts
 *
 *   Ported faithfully from scripts/eval/coord-first-probe.py.
 */

import { existsSync, globSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const ADMIN_DE = "/mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data/whosonfirst-data-admin-de/data"
const PC_DB = "/mnt/playpen/mailwoman-data/wof/postalcode-intl.db"
const SAMPLE = "data/eval/external/openaddresses-de-sample.jsonl"

type Ring = number[][]
interface Geometry {
	type: string
	coordinates: unknown
}

// ---- ray-cast PIP (even-odd, handles holes + MultiPolygon); x=lon, y=lat ----
function inRing(x: number, y: number, ring: Ring): boolean {
	let inside = false
	const n = ring.length
	let j = n - 1

	for (let i = 0; i < n; i++) {
		const xi = ring[i]![0]!
		const yi = ring[i]![1]!
		const xj = ring[j]![0]!
		const yj = ring[j]![1]!

		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside
		}
		j = i
	}

	return inside
}
function inPoly(x: number, y: number, poly: Ring[]): boolean {
	let c = false

	for (const ring of poly) {
		if (inRing(x, y, ring)) {
			c = !c
		}
	}

	return c
}
function inGeom(x: number, y: number, geom: Geometry): boolean {
	const t = geom.type

	if (t === "Polygon") return inPoly(x, y, geom.coordinates as Ring[])

	if (t === "MultiPolygon") return (geom.coordinates as Ring[][]).some((p) => inPoly(x, y, p))

	return false
}

interface Loc {
	id: number
	name: string
	minx: number
	miny: number
	maxx: number
	maxy: number
	geom: Geometry
}

// ---- load DE current locality polygons (from SOURCE GeoJSON) with bbox prefilter ----
console.log("loading DE locality polygons from source GeoJSON...")
const locs: Loc[] = []

for (const fp of globSync(ADMIN_DE + "/**/*.geojson")) {
	try {
		const g = JSON.parse(readFileSync(fp, "utf-8"))
		const p = g.properties ?? {}

		if (p["wof:placetype"] !== "locality" || (p["mz:is_current"] ?? 1) === 0) continue
		const geom = g.geometry as Geometry | undefined

		if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue
		// bbox from coords
		const xs: number[] = []
		const ys: number[] = []
		const walk = (c: unknown): void => {
			const arr = c as unknown[]

			if (typeof arr[0] === "number") {
				xs.push(arr[0] as number)
				ys.push(arr[1] as number)
			} else {
				for (const cc of arr) {
					walk(cc)
				}
			}
		}
		walk(geom.coordinates)
		locs.push({
			id: parseInt(String(p["wof:id"]), 10),
			name: p["wof:name"] ?? "",
			minx: Math.min(...xs),
			miny: Math.min(...ys),
			maxx: Math.max(...xs),
			maxy: Math.max(...ys),
			geom,
		})
	} catch {
		/* pass */
	}
}
console.log(`  ${locs.length} DE localities loaded`)

/** Return [id, name] of the DE locality whose polygon contains (lon,lat), or null. */
function pipLocality(lon: number, lat: number): [number, string] | null {
	for (const l of locs) {
		if (l.minx <= lon && lon <= l.maxx && l.miny <= lat && lat <= l.maxy && inGeom(lon, lat, l.geom)) {
			return [l.id, l.name]
		}
	}

	return null
}

// ---- postcode centroids from our custom postalcode-intl.db ----
const con = new DatabaseSync(PC_DB, { readOnly: true })
const pcCentroid = new Map<string, [number, number]>()

for (const row of con
	.prepare("SELECT name, latitude, longitude FROM spr WHERE country='DE' AND placetype='postalcode'")
	.all() as Array<{ name: string; latitude: number; longitude: number }>) {
	pcCentroid.set(row.name, [row.latitude, row.longitude])
}
console.log(`  ${pcCentroid.size} DE postcode centroids loaded`)

// ---- name-match signal (from the resolver dump, joined by input) ----
// resolved-v072-de.json carries the neural-resolved locality WOF id per row; "name-correct" means
// that resolved locality IS the true containing locality (== name-match PIP-containment from #273).
let dump: Record<string, unknown> = {}

try {
	const arr = JSON.parse(readFileSync("/tmp/resolved-v072-de.json", "utf-8")) as Array<Record<string, unknown>>
	dump = Object.fromEntries(arr.map((d) => [d.input as string, d.neuralLocID]))
} catch {
	dump = {}
}

// Load the resolver's resolved-locality polygon by WOF id so "name-correct" = gold point inside the
// RESOLVER's chosen polygon (== #273's 77.1%), not an id-equality against our independently-PIP'd
// truth (which mismatches on granularity, e.g. Berlin city vs borough).
const adminRoots = [
	...globSync("/mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data/whosonfirst-data-admin-*/data").sort(),
	"/mnt/playpen/mailwoman-data/wof/repos/whosonfirst-data-admin-us/data",
]
const gcache = new Map<string, Geometry | null>()
function geomForID(wid: unknown): Geometry | null {
	const key = String(wid)

	if (gcache.has(key)) return gcache.get(key)!
	const s = String(Math.trunc(Number(wid)))
	const chunks: string[] = []

	for (let i = 0; i < s.length; i += 3) {
		chunks.push(s.slice(i, i + 3))
	}
	const rel = chunks.join("/") + `/${s}.geojson`
	let g: Geometry | null = null

	for (const root of adminRoots) {
		const fp = join(root, rel)

		if (existsSync(fp)) {
			try {
				g = (JSON.parse(readFileSync(fp, "utf-8")).geometry as Geometry) ?? null
			} catch {
				g = null
			}
			break
		}
	}
	gcache.set(key, g)

	return g
}

// ---- run the probe over the DE sample ----
interface Counts {
	n: number
	truth: number
	name: number
	has_pc: number
	cf: number
	hybrid: number
}
const newCounts = (): Counts => ({ n: 0, truth: 0, name: 0, has_pc: 0, cf: 0, hybrid: 0 })

const rows = readFileSync(SAMPLE, "utf-8")
	.split(/\r?\n/)
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Record<string, unknown>)
const ov = newCounts()
const by = new Map<string, Counts>()

for (const r of rows) {
	const st = (r.state as string) || "??"
	let byst = by.get(st)

	if (!byst) {
		byst = newCounts()
		by.set(st, byst)
	}
	ov.n += 1
	byst.n += 1
	const glon = r.lon as number
	const glat = r.lat as number
	// ground truth: which DE locality actually contains the gold point
	const truth = pipLocality(glon, glat)

	if (truth) {
		ov.truth += 1
		byst.truth += 1
	}
	const truthID = truth ? truth[0] : null
	// name signal: is the gold point inside the RESOLVER's chosen locality polygon? (== #273)
	const nlid = dump[r.input as string]
	const ngeom = nlid ? geomForID(nlid) : null
	const nameOk = ngeom !== null && ngeom !== undefined && inGeom(glon, glat, ngeom)

	if (nameOk) {
		ov.name += 1
		byst.name += 1
	}
	const pc = (r.expected as Record<string, unknown> | undefined)?.postcode as string | undefined
	const cen = pc ? pcCentroid.get(pc) : undefined

	if (!cen) {
		if (nameOk) {
			ov.hybrid += 1
			byst.hybrid += 1
		}
		continue
	}
	ov.has_pc += 1
	byst.has_pc += 1
	const cand = pipLocality(cen[1], cen[0]) // cen=(lat,lon) -> pip(lon,lat)
	// coordinate-first containment: does the gold point fall inside the centroid-PIP'd locality?
	const cfOk = cand !== null && truthID !== null && cand[0] === truthID

	if (cfOk) {
		ov.cf += 1
		byst.cf += 1
	}

	// HYBRID ceiling: name signal OR coordinate signal lands the true locality
	if (nameOk || cfOk) {
		ov.hybrid += 1
		byst.hybrid += 1
	}
}

function line(label: string, c: Counts): string {
	const n = c.n

	if (!n) return `  ${label}: n=0`
	const pct = (k: keyof Counts): string => ((100 * c[k]) / n).toFixed(1) + "%"

	return `  ${label.padEnd(10)} n=${String(n).padEnd(5)} name=${pct("name").padEnd(7)} coord-first=${pct("cf").padEnd(7)} HYBRID(name OR coord)=${pct("hybrid")}`
}

console.log("\n=== Resolver containment by signal (gold point inside the chosen locality) ===")
console.log(line("OVERALL", ov))

for (const st of [...by.keys()].sort()) {
	console.log(line(st, by.get(st)!))
}
console.log("\n  name = resolver's current name-match resolution; coord-first = postcode centroid -> PIP locality;")
console.log("  HYBRID = either signal lands the true locality (the soft-scoring ceiling).")
