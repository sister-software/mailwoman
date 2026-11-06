/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads IATA airport codes from Wikidata's property P238 as landmark rows keyed by the same items as the vital-places
 *   inventory. Wikidata publishes this data under CC0.
 */

import type { SPARQLResults } from "@mailwoman/corpus/tools/fetch/wikidata/subvenue"
import { isLandmarkCode, landmarkNameKey, type LandmarkNameTable } from "@mailwoman/resolver-wof-sqlite/landmark"

/**
 * Every located aerodrome with an IATA code that Wikidata records no closing date for.
 *
 * The class test matters because a metropolitan area's code also sits on its city: Paris has the code `PAR`.
 */
export const AIRPORT_CODES_QUERY = `SELECT ?item ?itemLabel ?iata ?coord ?links ?cc WHERE {
  ?item wdt:P238 ?iata; wdt:P625 ?coord; wikibase:sitelinks ?links; wdt:P31/wdt:P279* wd:Q62447.
  FILTER NOT EXISTS { ?item wdt:P576 ?closed }
  OPTIONAL { ?item wdt:P17/wdt:P297 ?cc }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`

/**
 * One airport as the query answers it.
 */
export interface AirportCode {
	qid: string
	name: string
	iata: string
	lat: number
	lon: number
	sitelinks: number
	country: string | null
}

/**
 * Reads the query's answer, keeping an airport's first row, because a second coordinate
 * or country repeats its item.
 *
 * A row with an unreadable coordinate or a code that is not one is left out.
 */
export function readAirportCodes(results: SPARQLResults): AirportCode[] {
	const airports = new Map<string, AirportCode>()

	for (const binding of results.results.bindings) {
		const qid = binding["item"]?.value.split("/").at(-1)
		const iata = binding["iata"]?.value
		const point = /^Point\((-?[\d.]+) (-?[\d.]+)\)$/.exec(binding["coord"]?.value ?? "")

		if (!qid || !iata || !point || !isLandmarkCode(iata) || airports.has(`${qid}:${iata}`)) continue

		airports.set(`${qid}:${iata}`, {
			qid,
			iata,
			name: binding["itemLabel"]?.value ?? iata,
			lat: Number(point[2]),
			lon: Number(point[1]),
			sitelinks: Number(binding["links"]?.value ?? 0),
			country: binding["cc"]?.value ?? null,
		})
	}

	return [...airports.values()]
}

/**
 * The rows one airport contributes: its code and its English name, both its own primary names.
 */
export function airportRows(airport: AirportCode): LandmarkNameTable[] {
	const base = {
		qid: airport.qid,
		name: airport.name,
		kind: "venue" as const,
		country: airport.country,
		latitude: airport.lat,
		longitude: airport.lon,
		sitelinks: airport.sitelinks,
		is_primary: 1,
		importance: null,
		h3_cell: null,
	}

	const rows: LandmarkNameTable[] = [{ ...base, name_key: landmarkNameKey(airport.iata), code: airport.iata }]

	// An unlabeled item comes back with its id or code as its label, and neither is a written name.
	if (airport.name !== airport.iata && airport.name !== airport.qid) {
		rows.push({ ...base, name_key: landmarkNameKey(airport.name), code: null })
	}

	return rows
}
