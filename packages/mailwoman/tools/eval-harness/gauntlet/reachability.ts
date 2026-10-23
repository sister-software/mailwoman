/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whether a row's expected admin component can be reached by the resolver at all.
 *
 *   The resolver looks a tag up in one placetype band (`locality` queries `locality`, `borough` and
 *   `localadmin`). A gazetteer that holds the expected value only in another band, such as a GB town typed
 *   `neighbourhood`, makes the row's coordinate assertion unreachable through that component under every
 *   parse. That is a data condition, and this module reads it from `candidate.db` so a diagnosis names it
 *   instead of grading it as a model failure.
 */

import { expandPlacetypeFilter, placetypeMapForCountry } from "@mailwoman/codex/placetype-map"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import type { DatabaseClient } from "@mailwoman/sqlite/client"

/**
 * The placetype the postcode tag maps to.
 *
 * A postcode resolves through the postcode extract rather than the candidate table, so it has no band here.
 */
const POSTCODE_PLACETYPE = "postalcode"

/**
 * The placetype band the resolver queries for an expected tag in a country.
 *
 * The band is the codex placetype for the tag, expanded through the resolver's filter groups.
 * A tag the placetype map does not route to the candidate table, such as `street`,
 * `venue` or `postcode`, returns `null`.
 */
export function placetypeBand(tag: string, country: string | null): readonly string[] | null {
	const map: Partial<Record<string, string>> = placetypeMapForCountry(country)
	const placetype = map[tag]

	if (!placetype || placetype === POSTCODE_PLACETYPE) return null

	return expandPlacetypeFilter([placetype])
}

/**
 * The rows a probe found for one expected value in one country, by placetype.
 */
export type PlacetypeCounts = Record<string, number>

/**
 * A probe of the candidate table for a folded value in a country, returning the row count per placetype.
 */
export type CandidateBandProbe = (value: string, country: string) => PlacetypeCounts

/**
 * One expected component's reachability reading.
 *
 * - `reachable`: the band holds at least one row for the value.
 * - `unreachable`: the band holds none while another placetype does, so the resolver can never pick it.
 * - `absent`: no placetype holds the value in this country.
 * - `unprobed`: the row states no country, so the band could not be queried.
 */
export interface ComponentReachability {
	tag: string
	value: string
	band: readonly string[] | null
	state: "reachable" | "unreachable" | "absent" | "unprobed"
	/**
	 * Rows inside the band, summed over its placetypes.
	 */
	in_band: number
	/**
	 * Rows outside the band, by placetype, so a reading states where the key lives.
	 */
	outside_band: PlacetypeCounts
}

/**
 * Reads the reachability of every expected admin component of a row.
 *
 * The probe runs once per component that has a band.
 * A component without a band, such as a street or a venue, is left out.
 *
 * A row without a country is read as `unprobed` rather than as reachable,
 * because an unread condition is not a passing one.
 */
export function readExpectationReachability(
	expected: Readonly<Record<string, string>>,
	country: string | null,
	probe: CandidateBandProbe
): ComponentReachability[] {
	const readings: ComponentReachability[] = []

	for (const [tag, value] of Object.entries(expected)) {
		if (!value) continue

		const band = placetypeBand(tag, country)

		if (!band) continue

		if (!country) {
			readings.push({ tag, value, band, state: "unprobed", in_band: 0, outside_band: {} })

			continue
		}

		const counts = probe(value, country)
		let inBand = 0
		const outside: PlacetypeCounts = {}

		for (const [placetype, n] of Object.entries(counts)) {
			if (band.includes(placetype)) {
				inBand += n
			} else if (n > 0) {
				outside[placetype] = n
			}
		}

		const state = inBand > 0 ? "reachable" : Object.keys(outside).length ? "unreachable" : "absent"

		readings.push({ tag, value, band, state, in_band: inBand, outside_band: outside })
	}

	return readings
}

/**
 * Builds a {@link CandidateBandProbe} over an open `candidate.db`, folding the value
 * with the same `name_key` normalization the build and the runtime lookup apply.
 */
export function candidateBandProbe<DB>(db: DatabaseClient<DB>): CandidateBandProbe {
	const statement = db.prepare(
		"SELECT pc.placetype AS placetype, count(*) AS n FROM candidate c " +
			"JOIN placetype_codes pc ON pc.id = c.placetype_id JOIN country_codes cc ON cc.id = c.country_id " +
			"WHERE c.name_key = ? AND cc.code = ? GROUP BY pc.placetype"
	)

	return (value, country) => {
		const key = normalizeLocalityForKey(value)

		if (!key) return {}

		const rows = statement.all(key, country.toUpperCase()) as Array<{ placetype: string; n: number }>

		return Object.fromEntries(rows.map((row) => [row.placetype, row.n]))
	}
}

/**
 * Renders the placetypes a key lives in, largest count first, as `locality ×5, localadmin ×2`.
 */
export function describePlacetypeCounts(counts: Readonly<PlacetypeCounts>): string {
	return Object.entries(counts)
		.toSorted(([, a], [, b]) => b - a)
		.map(([placetype, n]) => `${placetype} ×${n}`)
		.join(", ")
}

/**
 * Renders one reading's condition in the words the regression layer and `mwdev_diagnose` both print.
 *
 * A reachable reading renders as `null`.
 * The reports list conditions, and a confirmation on every reachable component would bury them.
 */
export function describeComponentReachability(reading: ComponentReachability, country: string | null): string | null {
	const expected = `expected ${reading.tag} "${reading.value}"`
	const where = country ?? "?"

	switch (reading.state) {
		case "unreachable":
			return (
				`${expected} UNREACHABLE in band [${reading.band?.join(", ")}]: ` +
				`${where} holds it as ${describePlacetypeCounts(reading.outside_band)}`
			)
		case "absent":
			return `${expected} ABSENT from every placetype in ${where}`
		case "unprobed":
			return `${expected} reachability UNPROBED (the row states no country)`
		case "reachable":
			return null
	}
}
