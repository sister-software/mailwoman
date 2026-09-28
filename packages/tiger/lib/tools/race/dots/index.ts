/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A dot is a representation rather than a record: a random position inside the block it belongs to,
 *   making no statement about any individual address.
 */

import { dataRootPath, tempRootPath } from "@mailwoman/core/data-root"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { TIGERDatabase } from "#sdk/schema"

const MAX_PLACEMENT_TRIES = 60

/**
 * Options for {@linkcode raceDots}.
 */
export interface RaceDotsOptions {
	/**
	 * Tiger SQLite DB (`tabblock20` ⋈ `pl_block`).
	 */
	db?: string
	/**
	 * Output ndjson path.
	 */
	out?: string
	/**
	 * People represented by one dot.
	 */
	per?: number
	/**
	 * Tippecanoe layer name.
	 */
	layer?: string
}

/**
 * Result of {@linkcode raceDots}.
 */
export interface RaceDotsResult {
	outPath: string
	dots: number
	skipped: number
	blocks: number
	/**
	 * Dots emitted per P2 category.
	 */
	totals: Record<string, number>
}

/**
 * The P2 categories (columns in `pl_block`) that partition each block's population.
 */
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

/**
 * Race-by-dot-density ndjson builder.
 */
export async function raceDots(
	options: RaceDotsOptions = {},
	report?: (line: string) => void
): Promise<RaceDotsResult> {
	const DB = options.db || dataRootPath("tiger", "tiger-oc.db")
	const OUT = options.out || tempRootPath("race-dots.ndjson")
	const PER = options.per ?? 10
	const LAYER = options.layer || "dots"

	// Heavy dep, lazy-imported so loading the tools barrel stays cheap.
	const { default: booleanContains } = await import("@turf/boolean-contains")

	// Pick a bbox-area-weighted sub-polygon, then rejection-sample inside it; turf handles holes and winding.
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

		for (let tries = 0; tries < MAX_PLACEMENT_TRIES; tries++) {
			const x = minX + Math.random() * (maxX - minX)
			const y = minY + Math.random() * (maxY - minY)
			const pt = { type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [x, y] }, properties: {} }

			if (booleanContains(polyFeature, pt)) return [x, y]
		}

		return null
	}

	using db = new DatabaseClient<TIGERDatabase>(DB, { readOnly: true })

	const rows = db
		.prepare(
			`SELECT b.geometry AS geometry, ${CATEGORIES.map((c) => `p.${c} AS ${c}`).join(", ")}
			 FROM tabblock20 b JOIN pl_block p ON b.GEOID = p.GEOID
			 WHERE p.pop_total > 0`
		)
		.all() as Array<{ geometry: string } & Record<(typeof CATEGORIES)[number], number>>

	const out = openWriteStream(OUT)
	const totals = new Map<string, number>()

	let dots = 0,
		skipped = 0

	for (const row of rows) {
		const geom = tryParsingJSON<{ type: string; coordinates: unknown }>(row.geometry)

		if (!geom) continue

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
					stringifyJSON({
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

	await new Promise<void>((resolve) => {
		out.on("finish", () => resolve())
	})

	report?.(`[done] ${dots} dots from ${rows.length} blocks (1 dot ≈ ${PER} people); ${skipped} skipped`)

	for (const [cat, n] of [...totals.entries()].toSorted((a, b) => b[1] - a[1])) {
		report?.(`  ${n.toString().padStart(7)}  ${cat}`)
	}

	return { outPath: OUT, dots, skipped, blocks: rows.length, totals: Object.fromEntries(totals) }
}
