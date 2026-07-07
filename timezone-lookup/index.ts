/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/timezone-lookup` — coordinate → IANA timezone, server-side. Point-in-polygon over the
 *   timezone-boundary-builder polygons stored in a `node:sqlite` DB (bbox-prefilter + ray-cast),
 *   mirroring the resolver's PIP pattern. The UTC offset comes from `Intl.DateTimeFormat` — no tz
 *   database dependency. Build the DB with `mailwoman-timezone build` (see `./build.ts`).
 */

import { DatabaseSync } from "node:sqlite"

import type { AnnotationSet, Annotator } from "@mailwoman/annotations"

/**
 * Normalized geometry: an array of polygons, each `[outerRing, ...holes]`, each ring `[[lon,lat],…]`.
 */
export type MultiPolygonCoords = number[][][][]

/** Ray-cast point-in-ring (even-odd rule). `ring` is `[[lon, lat], …]`. */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
	let inside = false

	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i]![0]!
		const yi = ring[i]![1]!
		const xj = ring[j]![0]!
		const yj = ring[j]![1]!

		if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
			inside = !inside
		}
	}

	return inside
}

/** Inside the outer ring and outside every hole. */
function pointInPolygon(lon: number, lat: number, polygon: number[][][]): boolean {
	if (!polygon[0] || !pointInRing(lon, lat, polygon[0])) return false

	for (let i = 1; i < polygon.length; i++) if (pointInRing(lon, lat, polygon[i]!)) return false

	return true
}

/** Inside any polygon of a (multi)polygon feature. */
export function pointInMultiPolygon(lon: number, lat: number, polygons: MultiPolygonCoords): boolean {
	return polygons.some((polygon) => pointInPolygon(lon, lat, polygon))
}

/**
 * The current UTC offset (seconds) for an IANA timezone, via `Intl` (no tz-db dependency). Returns `undefined` if the
 * runtime can't resolve the zone.
 */
export function offsetSecForTimezone(tzid: string, date: Date = new Date()): number | undefined {
	try {
		const parts = new Intl.DateTimeFormat("en-US", { timeZone: tzid, timeZoneName: "longOffset" }).formatToParts(date)
		const name = parts.find((p) => p.type === "timeZoneName")?.value ?? ""
		const match = name.match(/GMT([+-])(\d{2}):?(\d{2})?/)

		if (!match) return name === "GMT" ? 0 : undefined
		const sign = match[1] === "-" ? -1 : 1
		const hours = Number(match[2])
		const minutes = Number(match[3] ?? "0")

		return sign * (hours * 3600 + minutes * 60)
	} catch {
		return undefined
	}
}

/** A timezone lookup over a built `node:sqlite` polygon DB. */
export class TimezoneLookup {
	#db: DatabaseSync
	#stmt: ReturnType<DatabaseSync["prepare"]>

	constructor(opts: { databasePath: string } | { database: DatabaseSync }) {
		this.#db = "database" in opts ? opts.database : new DatabaseSync(opts.databasePath, { readOnly: true })
		// Candidate features whose bbox contains the point; PIP picks the exact one.
		this.#stmt = this.#db.prepare(
			`SELECT tzid, geom FROM timezone_polygons
			 WHERE minLat <= ? AND maxLat >= ? AND minLon <= ? AND maxLon >= ?`
		)
	}

	/** The IANA timezone id containing `(lat, lon)`, or `null` if none (shouldn't happen with oceans). */
	find(lat: number, lon: number): string | null {
		const rows = this.#stmt.all(lat, lat, lon, lon) as Array<{ tzid: string; geom: string }>

		for (const row of rows) {
			if (pointInMultiPolygon(lon, lat, JSON.parse(row.geom) as MultiPolygonCoords)) return row.tzid
		}

		return null
	}

	close(): void {
		this.#db.close()
	}
}

/** Build an `Annotator` that fills `AnnotationSet.timezone` (name + current offset) from a lookup. */
export function makeTimezoneAnnotator(lookup: TimezoneLookup): Annotator {
	return ({ lat, lon, date }): Partial<AnnotationSet> => {
		const name = lookup.find(lat, lon)

		if (!name) return {}
		const offsetSec = offsetSecForTimezone(name, date)

		return { timezone: offsetSec != null ? { name, offsetSec } : { name } }
	}
}
