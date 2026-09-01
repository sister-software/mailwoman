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
 *   Usage: node scripts/build-postcode-locality.ts --country DE\
 *   --admin-repo $MAILWOMAN_DATA_ROOT/wof/repos/whosonfirst-data/whosonfirst-data-admin-de\
 *   --postcode-db $MAILWOMAN_DATA_ROOT/wof/postalcode-intl.db\
 *   --output $MAILWOMAN_DATA_ROOT/wof/postcode-locality-de.db\
 *   --radius-km 10 --max-candidates 4
 *
 *   PORT NOTE (from scripts/build-postcode-locality.py): faithful TypeScript port. Point-in-polygon
 *   REUSES the canonical even-odd ray cast `geometryContains` from `@mailwoman/spatial`
 *   (byte-identical to the Python `in_geom`/`ray_in_ring`; `scripts/eval/pip-containment.py` is the
 *   one copy no import can reach and must be matched by hand). Haversine is ported inline (asin form)
 *   to match the Python exactly. The output is written DIRECTLY to `--output` — NOT via a
 *   temp-then-move — because this builder is deliberately ACCUMULATIVE: `CREATE TABLE IF NOT
 *   EXISTS` + `DELETE FROM … WHERE country=?` lets one shared DB be filled DE, FR, … in successive
 *   `--country` runs (a temp-build would wipe prior countries' rows).
 */

import { pathExists, readDirectoryRecursive, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pyRound } from "@mailwoman/core/numeric"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { isoSecondsUTC } from "@mailwoman/core/utils"
import { geometryContains, haversineKm, type ParsedGeometry } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { join } from "path-ts"

import { finalizeSealedBuild } from "#gazetteer-pipeline/database-lifecycle"
import {
	createPostcodeLocalityIndex,
	createPostcodeLocalityMetaTable,
	createPostcodeLocalityTable,
	POSTCODE_LOCALITY_INSERT_SQL,
	type PostcodeLocalityDatabase,
} from "#gazetteer-pipeline/postcode-locality/schema"
import { writeMetaRows } from "#gazetteer-pipeline/postcode/geonames-tail"

/**
 * Plus name:* / label:* props, gathered below.
 */
const ALT_NAME_KEYS = new Set(["wof:label"])

/**
 * WOF alt-name aliases from name:* / label:* props (+ `wof:label`), minus the canonical.
 */
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

	return [...out].toSorted()
}

/**
 * Push `v` into the array bucket at `k`, creating it on first touch (Python `defaultdict(list)`).
 */
function pushTo<V>(m: Map<string, V[]>, k: string, v: V): void {
	const a = m.get(k)

	if (a) {
		a.push(v)
	} else {
		m.set(k, [v])
	}
}

/**
 * A fixed-cell proximity grid: entries bucketed by cell, neighbors gathered from the 3×3 block around a query
 * coordinate, filtered by great-circle radius, and answered nearest-first under a caller-owned tie-break.
 *
 * THE CELL KEYING IS PART OF EACH BUILDER'S OUTPUT CONTRACT — `pyRound` vs `Math.round`, ×10 (0.1°) vs ×2 (0.5°) — so
 * it is a constructor parameter rather than a convention, and a builder's keying must not be "fixed" to match a
 * sibling's.
 */
export class ProximityGrid<Entry> {
	readonly #cells = new Map<string, Entry[]>()
	readonly #cellOf: (longitude: number, latitude: number) => readonly [number, number]
	readonly #positionOf: (entry: Entry) => readonly [number, number]
	readonly #compare: (left: Entry, right: Entry) => number

	constructor(options: {
		cellOf: (longitude: number, latitude: number) => readonly [number, number]
		/**
		 * `[latitude, longitude]` of one entry.
		 */
		positionOf: (entry: Entry) => readonly [number, number]
		/**
		 * Tie-break beyond ascending distance.
		 */
		compare: (left: Entry, right: Entry) => number
	}) {
		this.#cellOf = options.cellOf
		this.#positionOf = options.positionOf
		this.#compare = options.compare
	}

	add(entry: Entry): void {
		const [latitude, longitude] = this.#positionOf(entry)
		const [cx, cy] = this.#cellOf(longitude, latitude)
		pushTo(this.#cells, `${cx}|${cy}`, entry)
	}

	/**
	 * Entries within `radiusKM` of the coordinate, nearest-first.
	 */
	nearby(latitude: number, longitude: number, radiusKM: number): Array<{ d: number; entry: Entry }> {
		const [cx, cy] = this.#cellOf(longitude, latitude)
		const out: Array<{ d: number; entry: Entry }> = []

		for (const dx of [-1, 0, 1]) {
			for (const dy of [-1, 0, 1]) {
				for (const entry of this.#cells.get(`${cx + dx}|${cy + dy}`) ?? []) {
					const [entryLat, entryLon] = this.#positionOf(entry)
					const d = haversineKm(latitude, longitude, entryLat, entryLon)

					if (d <= radiusKM) {
						out.push({ d, entry })
					}
				}
			}
		}

		out.sort((a, b) => a.d - b.d || this.#compare(a.entry, b.entry))

		return out
	}
}

interface Locality {
	id: number
	name: string
	aliases: string[]
	clat: number
	clon: number
	bbox: [number, number, number, number]
	geom: ParsedGeometry
}

export interface PostcodeLocalityBaseOptions {
	country?: string
	adminRepo?: string
	postcodeDB?: string
	output: string
	radiusKM: number
	maxCandidates: number
	finalize: boolean
}

/**
 * Freeze the accumulated table into a self-contained, read-only, distributable sqlite asset (the same shape as our
 * other WOF tables): a provenance/license `meta` table, query-planner stats, an integrity check, a rollback (non-WAL)
 * journal mode so there's no sidecar, and a VACUUM to compact.
 */
export async function finalizePostcodeLocality(output: string): Promise<void> {
	using db = new DatabaseClient<PostcodeLocalityDatabase>(output)

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
			.toSorted()
			.map((c) => {
				const s = summary.get(c)!

				return `${JSON.stringify(c)}: {"containing": ${s.containing}, "rows": ${s.rows}}`
			})
			.join(", ") +
		"}"

	await createPostcodeLocalityMetaTable(db, { ifNotExists: true })

	const meta: Array<[string, string]> = [
		["name", "mailwoman-postcode-locality"],
		["description", "postcode → containing + nearby WOF locality candidates (coordinate-first resolution)"],
		["schema_version", "1"],
		["built_at", isoSecondsUTC()],
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

	writeMetaRows(db, meta)

	finalizeSealedBuild(db, output)

	// Python prints the dict repr (insertion order rows→containing, single quotes).
	const summaryRepr =
		"{" +
		[...summary.entries()].map(([c, s]) => `'${c}': {'rows': ${s.rows}, 'containing': ${s.containing}}`).join(", ") +
		"}"

	console.log(`finalized ${output}: integrity=ok, countries=${summaryRepr}`)
}

/**
 * Recursively collect every `.geojson` file under `dir` (Python's recursive `glob` over `data`).
 */
async function geojsonFiles(dir: string): Promise<string[]> {
	if (!(await pathExists(dir))) return []

	return ((await readDirectoryRecursive(dir)) as string[])
		.filter((p) => p.endsWith(".geojson"))
		.map((p) => join(dir, p))
}

export async function buildPostcodeLocalityBase(args: PostcodeLocalityBaseOptions): Promise<void> {
	const { country, adminRepo, postcodeDB, output, radiusKM, maxCandidates } = args

	console.log(`loading ${country} locality polygons from source GeoJSON…`)

	const locs: Locality[] = []

	for (const fp of await geojsonFiles(join(adminRepo!, "data"))) {
		try {
			const g = tryParsingJSON<{ properties?: Record<string, unknown>; geometry?: ParsedGeometry }>(
				await readLocalTextFile(fp)
			)

			if (!g) continue
			const p: Record<string, unknown> = g.properties ?? {}

			if (p["wof:placetype"] !== "locality" || (p["mz:is_current"] ?? 1) === 0) continue
			const geom = g.geometry

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
	const grid = new ProximityGrid<number>({
		cellOf: (lon, lat) => [pyRound(lon * 10), pyRound(lat * 10)],
		positionOf: (idx) => [locs[idx]!.clat, locs[idx]!.clon],
		compare: (a, b) => a - b,
	})

	const bgrid = new Map<string, number[]>()

	for (let idx = 0; idx < locs.length; idx++) {
		const l = locs[idx]!
		grid.add(idx)
		const [minx, miny, maxx, maxy] = l.bbox

		for (let cx = Math.floor(minx * 10); cx <= Math.floor(maxx * 10); cx++) {
			for (let cy = Math.floor(miny * 10); cy <= Math.floor(maxy * 10); cy++) {
				pushTo(bgrid, `${cx}|${cy}`, idx)
			}
		}
	}

	using con = new DatabaseClient<PostcodeLocalityDatabase>(postcodeDB!)

	const postcodes = con
		.prepare("SELECT name, latitude, longitude FROM spr WHERE country=? AND placetype='postalcode' AND is_current!=0")
		.all(country!) as Array<{ name: string; latitude: number | null; longitude: number | null }>

	console.log(`  ${postcodes.length} ${country} postcode centroids`)

	let nContained = 0
	let rows = 0

	{
		using db = new DatabaseClient<PostcodeLocalityDatabase>(output)
		// Accumulate per country into one shared DB (the resolver attaches a SINGLE postcode_locality database
		// and country-filters at query time). CREATE-IF-NOT-EXISTS + DELETE-this-country makes each --country
		// run idempotent, so `--output postcode-locality-intl.db` can be filled DE, FR, … in turn.

		await createPostcodeLocalityTable(db, { ifNotExists: true })

		db.prepare("DELETE FROM postcode_locality WHERE country = ?").run(country!)

		const insert = db.prepare(POSTCODE_LOCALITY_INSERT_SQL)
		db.exec("BEGIN")

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
			const cand = grid.nearby(plat, plon, radiusKM).map(({ d, entry }) => ({ d, idx: entry }))

			const chosen: Array<{ d: number; idx: number; isc: number }> = []

			if (containingIdx !== null) {
				chosen.push({ d: 0, idx: containingIdx, isc: 1 })

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

		db.exec("COMMIT")

		await createPostcodeLocalityIndex(db, { ifNotExists: true })
	}

	console.log(
		`  wrote ${rows} rows (${nContained}/${postcodes.length} postcodes have a containing locality) → ${output}`
	)

	// The sealed-artifact invariant: a built DB is a read-only asset from the moment it exists.
	await sealDatabase(output)
}
