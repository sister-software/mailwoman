/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Race-by-dot-density builder — the Cooper Center "Racial Dot Map" recipe, from the TIGER DB the
 *   `mailwoman tiger` CLI produces.
 *
 *   Reads `tabblock20 ⋈ pl_block` (block geometry + Census 2020 P.L. 94-171 table P2 counts) and
 *   scatters one dot per `--per` people uniformly at random inside each block, tagged with its
 *   race/ethnicity category. Output is NDJSON (one GeoJSON Point Feature per line, with a
 *   `tippecanoe` layer hint) ready for `tippecanoe -o race-dots.pmtiles`.
 *
 *   Point-in-polygon uses `@turf/boolean-contains` (ships with `@mailwoman/tiger`). The dot is a
 *   _representation_, not a record: a random position inside the block it belongs to, standing in
 *   for `--per` real people of that category. It says nothing about any individual address.
 *
 *   Build the input DB first: mailwoman tiger fetch --state 06 --county 059 --out tiger-oc.db
 *   mailwoman tiger redistricting --state 06 --county 059 --out tiger-oc.db
 *
 *   Run: node --experimental-strip-types scripts/census/race-dots.ts\
 *   --db tiger-oc.db --per 10 --out /tmp/race-dots.ndjson
 */

import { createWriteStream } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import booleanContains from "@turf/boolean-contains"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: { db: { type: "string" }, layer: { type: "string" }, out: { type: "string" }, per: { type: "string" } },
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { db?: string; layer?: string; out?: string; per?: string }
const DB = values["db"] || dataRootPath("tiger", "tiger-oc.db")
const OUT = values["out"] || "/tmp/race-dots.ndjson"
const PER = Number(values["per"] || "10") // people represented by one dot
const LAYER = values["layer"] || "dots"

// The eight P2 categories (columns in pl_block) that partition each block's population.
const CATEGORIES = ["hispanic", "white", "black", "asian", "aian", "nhpi", "other", "multi"] as const

type Ring = number[][]
type PolygonCoords = Ring[]

function bbox(rings: PolygonCoords): [number, number, number, number] {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity

	for (const [x, y] of rings[0]!) {
		if (x! < minX) {
			minX = x!
		}

		if (x! > maxX) {
			maxX = x!
		}

		if (y! < minY) {
			minY = y!
		}

		if (y! > maxY) {
			maxY = y!
		}
	}

	return [minX, minY, maxX, maxY]
}

// A block geometry is one or more polygons. Pick a sub-polygon weighted by bbox area, then
// rejection-sample inside it with a turf containment test (handles holes + winding correctly).
function randomPointIn(polys: PolygonCoords[], areas: number[], totalArea: number): [number, number] | null {
	let r = Math.random() * totalArea
	let pick = 0

	while (pick < polys.length - 1 && (r -= areas[pick]!) > 0) {
		pick++
	}
	const poly = polys[pick]!
	const polyFeature = {
		type: "Feature" as const,
		geometry: { type: "Polygon" as const, coordinates: poly },
		properties: {},
	}
	const [minX, minY, maxX, maxY] = bbox(poly)

	for (let tries = 0; tries < 60; tries++) {
		const x = minX + Math.random() * (maxX - minX)
		const y = minY + Math.random() * (maxY - minY)
		const pt = { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [x, y] }, properties: {} }

		if (booleanContains(polyFeature, pt)) return [x, y]
	}

	return null
}

const db = new DatabaseSync(DB, { readOnly: true })
const rows = db
	.prepare(
		`SELECT b.geometry AS geometry, ${CATEGORIES.map((c) => `p.${c} AS ${c}`).join(", ")}
		 FROM tabblock20 b JOIN pl_block p ON b.GEOID = p.GEOID
		 WHERE p.pop_total > 0`
	)
	.all() as Array<{ geometry: string } & Record<(typeof CATEGORIES)[number], number>>
db.close()

const out = createWriteStream(OUT)
const totals = new Map<string, number>()
let dots = 0,
	skipped = 0

for (const row of rows) {
	let geom: { type: string; coordinates: unknown }

	try {
		geom = JSON.parse(row.geometry)
	} catch {
		continue
	}
	const polys: PolygonCoords[] =
		geom.type === "Polygon" ? [geom.coordinates as PolygonCoords] : (geom.coordinates as PolygonCoords[])
	const areas = polys.map((p) => {
		const [a, b, c, d] = bbox(p)

		return Math.max((c - a) * (d - b), 1e-12)
	})
	const totalArea = areas.reduce((s, a) => s + a, 0)

	for (const cat of CATEGORIES) {
		const people = row[cat]

		if (people <= 0) continue
		const exact = people / PER
		const n = Math.floor(exact) + (Math.random() < exact - Math.floor(exact) ? 1 : 0)

		for (let k = 0; k < n; k++) {
			const pt = randomPointIn(polys, areas, totalArea)

			if (!pt) {
				skipped++
				continue
			}
			out.write(
				JSON.stringify({
					type: "Feature",
					tippecanoe: { layer: LAYER },
					properties: { cat },
					geometry: { type: "Point", coordinates: [Math.round(pt[0] * 1e5) / 1e5, Math.round(pt[1] * 1e5) / 1e5] },
				}) + "\n"
			)
			dots++
			totals.set(cat, (totals.get(cat) ?? 0) + 1)
		}
	}
}

out.end()
console.error(`[done] ${dots} dots from ${rows.length} blocks (1 dot ≈ ${PER} people); ${skipped} skipped`)

for (const [cat, n] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
	console.error(`  ${n.toString().padStart(7)}  ${cat}`)
}
