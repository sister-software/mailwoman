/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The panel builder for the prominence-floor benchmark. It executes the frozen selection rules and
 *   contains no judgment of its own: the bands, the eligibility rule, the fill order and the seed all come
 *   from `benchmark-definition.json`, committed before any row was inspected.
 *
 *   The benchmark's addition is its band field. The same-data panel drew each gold above one population floor,
 *   so a floor arm admitted every gold case by construction. This builder fills one stratum per band from that
 *   band's rows. The record reports each band separately.
 *
 *   Rows are drawn from the per-country main-table dumps rather than `cities15000.txt`, because the point is
 *   to reach below 15,000. The dumps have the same columns, so `readCities` parses them unchanged.
 */

import {
	fillStratum,
	goldOf,
	groupByFoldedName,
	padRowIndex,
	type StratumFillCensus,
	type StratumResult,
	uniqueNameEligible,
} from "#tools/eval-harness/panel-fill"
import {
	bandFor,
	type ProminenceBand,
	type ProminenceFloorDefinition,
} from "#tools/eval-harness/prominence-floor/definition"
import type { SameDataPanelRow } from "#tools/eval-harness/same-data/fixture"
import type { GeoNamesCity } from "#tools/eval-harness/same-data/panel"

/**
 * One panel row.
 *
 * The same shape the same-data fixture, arms and scorer already read, plus the band it was drawn from.
 * So the recorder, the replay and the metrics need no second row interface.
 */
export interface ProminencePanelRow extends SameDataPanelRow {
	band: string
	country: string
}

export interface ProminencePanelInputs {
	definition: ProminenceFloorDefinition
	cities: readonly GeoNamesCity[]
	goldSets: ReadonlyMap<string, number[]>
}

export interface ProminencePanelResult {
	rows: ProminencePanelRow[]
	census: StratumFillCensus[]
}

/**
 * The provenance included in every row.
 *
 * The register is the per-country dump rather than a single filtered table,
 * so the row records which country's file it came from.
 */
function panelProvenance(definition: ProminenceFloorDefinition): SameDataPanelRow["source"] {
	return {
		register: definition.goldSource.register,
		license: definition.goldSource.license,
		attribution: definition.goldSource.attribution,
	}
}

/**
 * Build the panel by executing the frozen selection rules.
 *
 * Strata are filled band by band in the definition's order, using one shared used-set.
 * A geonameid taken by any gold-present stratum cannot reappear in a withheld-gold stratum.
 * The two strata of a band therefore contain disjoint rows.
 */
export function buildProminencePanel(inputs: ProminencePanelInputs): ProminencePanelResult {
	const { definition, cities, goldSets } = inputs
	const { seed, rowsPerStratum } = definition.sampling

	const byName = groupByFoldedName(cities)
	const used = new Set<string>()
	const rows: ProminencePanelRow[] = []
	const census: StratumFillCensus[] = []

	/**
	 * Rows whose name occurs exactly once across the registered countries
	 * and whose population falls in `band`.
	 * No earlier stratum can have taken the row.
	 */
	const eligibleIn = (band: ProminenceBand): GeoNamesCity[] =>
		uniqueNameEligible({
			subjects: cities,
			byName,
			used,
			// Through `bandFor` rather than a comparison written here, so the unbounded ceiling
			// and the refusal of a row with no recorded population are decided in one
			// place for the builder and the scorer alike.
			extra: (city) => bandFor([band], city.population ?? null) !== null,
		})

	const goldFor = (city: GeoNamesCity): number[] | null => goldSets.get(city.geonameid) ?? null

	for (const stratum of definition.strata) {
		for (const band of definition.populationBands) {
			const label = `${stratum.id}/${band.id}`

			const filled = fillStratum<GeoNamesCity, ProminencePanelRow>({
				stratum: label,
				eligible: eligibleIn(band),
				seed,
				target: rowsPerStratum,
				identify: (city) => city.geonameid,
				used,
				build: (city, index) => {
					const gold = goldFor(city)

					if (!gold) return { result: "ungradeable" } satisfies StratumResult<ProminencePanelRow>

					return {
						result: "row",
						row: {
							id: `${label.replace("/", "-")}-${padRowIndex(index)}`,
							stratum: label,
							band: band.id,
							country: city.country,
							query: city.name,
							// The withheld-gold stratum is what `goldPresent: false` marks:
							// The recorder uses it to choose candidates for removal after recording.
							// The scorer uses it to choose the denominator.
							goldPresent: !stratum.correctIsAbstention,
							gold: goldOf(city, gold),
							source: panelProvenance(definition),
						},
					}
				},
			})

			rows.push(...filled.rows)
			census.push(filled.census)
		}
	}

	return { rows, census }
}
