/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/timezone-lookup` — coordinate → iana timezone, server-side. Point-in-polygon over the
 *   timezone-boundary-builder polygons stored in a `node:sqlite` DB (bbox-prefilter + ray-cast),
 *   mirroring the resolver's PIP pattern. The UTC offset comes from `Intl.DateTimeFormat` — no tz
 *   database dependency. Build the DB with `mailwoman-timezone build` (see `./build.ts`).
 */

import type { AnnotationSet, Annotator } from "@mailwoman/annotations"
import { parseJSONStrict } from "@mailwoman/core/json"
import { pointInMultiPolygon, type MultiPolygonRings } from "@mailwoman/spatial/geometries/polygon"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { SQLiteLookup, type SQLiteLookupOptions } from "@mailwoman/sqlite/lookup"

import type { TimezoneDatabase } from "#schema"

/**
 * The current UTC offset (seconds) for an iana timezone, via `Intl` (no tz-db dependency).
 *
 * @returns `undefined` if the runtime can't resolve the zone.
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

/**
 * A timezone lookup over a built `node:sqlite` polygon DB.
 */
export class TimezoneLookup extends SQLiteLookup<TimezoneDatabase> {
	#stmt: ReturnType<DatabaseClient["prepare"]>

	constructor(opts: SQLiteLookupOptions<TimezoneDatabase>) {
		super(opts)

		// Candidate features whose bbox contains the point.
		// PIP picks the exact one.
		this.#stmt = this.database.prepare(
			`SELECT tzid, geom FROM timezone_polygons
			 WHERE minLat <= ? AND maxLat >= ? AND minLon <= ? AND maxLon >= ?`
		)
	}

	/**
	 * The iana timezone id containing `(lat, lon)`, or `null` if none (shouldn't happen with oceans).
	 */
	explore(lat: number, lon: number): string | null {
		const rows = this.#stmt.all(lat, lat, lon, lon) as Array<{ tzid: string; geom: string }>

		for (const row of rows) {
			const polygons = parseJSONStrict<MultiPolygonRings>(row.geom)

			if (pointInMultiPolygon(lon, lat, polygons)) {
				return row.tzid
			}
		}

		return null
	}
}

/**
 * Build an `Annotator` that fills `AnnotationSet.timezone` (name + current offset) from a lookup.
 */
export function makeTimezoneAnnotator(lookup: TimezoneLookup): Annotator {
	return ({ lat, lon, date }): Partial<AnnotationSet> => {
		// oxlint-disable-next-line unicorn/no-array-method-this-argument -- `lookup.find(lat, lon)` is a two-argument gazetteer probe rather than Array#find
		const name = lookup.explore(lat, lon)

		if (!name) return {}
		const offsetSec = offsetSecForTimezone(name, date)

		return { timezone: offsetSec != null ? { name, offsetSec } : { name } }
	}
}
