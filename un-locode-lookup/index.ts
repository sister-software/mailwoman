/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/un-locode-lookup` — place → UN/LOCODE (UNECE Code for Trade and Transport Locations).
 *   Two ways in: by country + place name (exact, diacritic-folded), or by nearest coordinate (for
 *   the ~⅓ of entries that carry one). Backed by a `node:sqlite` table built from the UNECE code
 *   list. An `@mailwoman/annotations` `Annotator`.
 */

import type { AnnotationSet, Annotator } from "@mailwoman/annotations"
import { DatabaseSync } from "node:sqlite"

/** Fold a place name to its match key: strip diacritics, lowercase, collapse whitespace. */
export function foldName(name: string): string {
	return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ")
}

/** Parse a UN/LOCODE coordinate (`"4923N 01522E"`) to decimal degrees, or null if absent/malformed. */
export function parseUnLocodeCoords(raw: string): { lat: number; lon: number } | null {
	const m = raw.trim().match(/^(\d{2})(\d{2})([NS])\s+(\d{3})(\d{2})([EW])$/)
	if (!m) return null
	const lat = (Number(m[1]) + Number(m[2]) / 60) * (m[3] === "S" ? -1 : 1)
	const lon = (Number(m[4]) + Number(m[5]) / 60) * (m[6] === "W" ? -1 : 1)
	return { lat, lon }
}

const EARTH_R_KM = 6371
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = ((bLat - aLat) * Math.PI) / 180
	const dLon = ((bLon - aLon) * Math.PI) / 180
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
	return 2 * EARTH_R_KM * Math.asin(Math.sqrt(s))
}

/** A UN/LOCODE lookup over a built `node:sqlite` table. */
export class UnLocodeLookup {
	#db: DatabaseSync
	#byName: ReturnType<DatabaseSync["prepare"]>
	#byBox: ReturnType<DatabaseSync["prepare"]>

	constructor(opts: { databasePath: string } | { database: DatabaseSync }) {
		this.#db = "database" in opts ? opts.database : new DatabaseSync(opts.databasePath, { readOnly: true })
		this.#byName = this.#db.prepare(
			"SELECT country, location FROM un_locode WHERE country = ? AND nameNorm = ? LIMIT 1"
		)
		this.#byBox = this.#db.prepare(
			"SELECT location, country, lat, lon FROM un_locode WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?"
		)
	}

	/** The UN/LOCODE (`"US NYC"`) for a country + place name, or null. */
	byName(country: string, name: string): string | null {
		const row = this.#byName.get(country.toUpperCase(), foldName(name)) as
			| { country: string; location: string }
			| undefined
		return row ? `${row.country} ${row.location}` : null
	}

	/** The nearest coordinate-bearing UN/LOCODE within `maxKm`, or null. */
	nearest(lat: number, lon: number, maxKm = 25): string | null {
		const dLat = maxKm / 111
		const dLon = maxKm / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
		const rows = this.#byBox.all(lat - dLat, lat + dLat, lon - dLon, lon + dLon) as Array<{
			location: string
			country: string
			lat: number
			lon: number
		}>
		let best: { code: string; km: number } | null = null
		for (const r of rows) {
			const km = haversineKm(lat, lon, r.lat, r.lon)
			if (km <= maxKm && (!best || km < best.km)) best = { code: `${r.country} ${r.location}`, km }
		}
		return best?.code ?? null
	}

	close(): void {
		this.#db.close()
	}
}

/**
 * Build an `Annotator` filling `AnnotationSet.unLocode`. Prefers a country + place-name match (when
 * the resolver supplies them via `countryCode` / `placeName`), and falls back to the nearest
 * coordinate.
 */
export function makeUnLocodeAnnotator(lookup: UnLocodeLookup, opts: { maxKm?: number } = {}): Annotator {
	return ({ lat, lon, countryCode, placeName }): Partial<AnnotationSet> => {
		const byName = countryCode && placeName ? lookup.byName(countryCode, placeName) : null
		const code = byName ?? lookup.nearest(lat, lon, opts.maxKm)
		return code ? { unLocode: code } : {}
	}
}
