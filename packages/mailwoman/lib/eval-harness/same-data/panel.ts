/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the panel for the same-data benchmark. It applies the frozen selection rules to GeoNames and emits rows.
 *   The builder does not make independent selection judgments.
 *
 *   Eligibility, query construction, gold, fill order and the sampling seed all come from
 *   `benchmark-definition.json`, committed before inspecting any row. Changes to its selection rules require a
 *   definition version and content-hash update.
 *
 *   A row's entity, name, coordinate and population come from `cities15000.txt` under CC-BY-4.0.
 *   `readGoldSets` turns the geonameid into the ids the candidate backend answers with. A geonameid whose
 *   join is not coherent is dropped before sampling with the count reported, because that count describes
 *   the gazetteer and reporting it keeps a coverage hole from reading as a panel choice.
 *
 *   Half the homograph rows carry a bearer that is not the most populous. A panel whose gold is always the
 *   largest bearer would be satisfied by a population prior alone. The benchmark tests that prior.
 */

import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { GEONAMES_MAIN_COLUMNS } from "@mailwoman/corpus/adapters/geonames/adapter"
import { GEONAMES_POSTAL_COLUMNS } from "@mailwoman/corpus/adapters/geonames/postal/adapter"
import { TSVSpliterator } from "spliterator"

import {
	fillStratum,
	goldOf,
	groupByFoldedName,
	padRowIndex,
	type StratumFillCensus,
	type StratumOutcome,
	uniqueNameEligible,
} from "#eval-harness/panel-fill"
import type { SameDataBenchmarkDefinition } from "#eval-harness/same-data/definition"
import type { SameDataPanelRow } from "#eval-harness/same-data/fixture"

const SOURCE = { register: "geonames:cities15000", license: "CC-BY-4.0", attribution: "GeoNames" } as const

const POPULATION_FLOOR = 50_000

/**
 * The homograph rule's contest floor: the runner-up must hold at least this share of the
 * largest bearer's population, so the pair is a real contest rather than a formality.
 */
const HOMOGRAPH_CONTEST_SHARE = 1 / 3

/**
 * `countryInfo.txt` column indices (0-based): ISO alpha-2 and the register's English short country name.
 */
const COUNTRY_INFO_COLUMNS = { iso: 0, country: 4 } as const

/**
 * The postal dump's admin1 code column.
 *
 * `@mailwoman/corpus`'s {@link GEONAMES_POSTAL_COLUMNS} puts the admin1 name at index 3
 * because corpus rows render that value.
 * This panel keys on the adjacent code.
 *
 * The code stays stable across the register's language variants.
 */
const POSTAL_ADMIN1_CODE_COLUMN = 4

/**
 * One row of `cities15000.txt`, in the columns this builder reads.
 */
export interface GeoNamesCity {
	geonameid: string
	name: string
	asciiname: string
	lat: number
	lon: number
	country: string
	admin1: string
	population: number
}

/**
 * Parse a GeoNames main-table dump.
 *
 * `header: false` matches the headerless dump.
 * A spliterator that assumes a header would consume the first row.
 *
 * A per-country dump (`FR.txt`) carries the same columns and parses here unchanged.
 */
export async function readCities(path: string): Promise<GeoNamesCity[]> {
	const rows: GeoNamesCity[] = []

	for await (const columns of TSVSpliterator.fromAsync(path, { header: false }) as AsyncIterable<string[]>) {
		if (!columns[GEONAMES_MAIN_COLUMNS.geonameid]) continue

		rows.push({
			geonameid: columns[GEONAMES_MAIN_COLUMNS.geonameid]!,
			name: columns[GEONAMES_MAIN_COLUMNS.name]!,
			asciiname: columns[GEONAMES_MAIN_COLUMNS.asciiname]!,
			lat: Number(columns[GEONAMES_MAIN_COLUMNS.latitude]),
			lon: Number(columns[GEONAMES_MAIN_COLUMNS.longitude]),
			country: columns[GEONAMES_MAIN_COLUMNS.country]!,
			admin1: columns[GEONAMES_MAIN_COLUMNS.admin1]!,
			population: Number(columns[GEONAMES_MAIN_COLUMNS.population] || 0),
		})
	}

	return rows
}

/**
 * The English short country names, read from `countryInfo.txt`.
 *
 * The register's own column, so a country qualifier is spelled the way the gold source spells it.
 */
export async function readCountryNames(path: string): Promise<Map<string, string>> {
	const names = new Map<string, string>()

	for await (const columns of TSVSpliterator.fromAsync(path, { header: false }) as AsyncIterable<string[]>) {
		const iso = columns[COUNTRY_INFO_COLUMNS.iso]

		// The file leads with a long `#`-commented preamble whose last line is the column header.
		if (!iso || iso.startsWith("#")) continue

		names.set(iso, columns[COUNTRY_INFO_COLUMNS.country]!)
	}

	return names
}

/**
 * The first postcode seen for each `(country, admin1)` pair, from `allCountries-postal.txt`.
 *
 * Taking the first makes the choice a property of the source instead of a second
 * seeded draw absent from the registry.
 * The file carries 1.8 million rows, so it is streamed and only the index is held.
 */
export async function readPostcodeByAdmin(path: string): Promise<Map<string, string>> {
	const byAdmin = new Map<string, string>()

	for await (const columns of TSVSpliterator.fromAsync(path, { header: false }) as AsyncIterable<string[]>) {
		const country = columns[GEONAMES_POSTAL_COLUMNS.country]
		const postcode = columns[GEONAMES_POSTAL_COLUMNS.postcode]

		if (!country || !postcode) continue

		const key = `${country}/${columns[POSTAL_ADMIN1_CODE_COLUMN] ?? ""}`

		if (!byAdmin.has(key)) {
			byAdmin.set(key, postcode)
		}
	}

	return byAdmin
}

/**
 * What the build dropped and why, reported beside the panel rather than folded into it.
 */
export type PanelBuildCensus = StratumFillCensus

export interface PanelBuildInputs {
	definition: SameDataBenchmarkDefinition
	cities: readonly GeoNamesCity[]
	countryNames: ReadonlyMap<string, string>
	postcodeByAdmin: ReadonlyMap<string, string>
	/**
	 * Geonameid → the coherent gold identity set, from `readGoldSets`.
	 *
	 * A geonameid absent from this map is ungradeable and can never enter the panel.
	 */
	goldSets: ReadonlyMap<string, number[]>
}

export interface PanelBuildResult {
	rows: SameDataPanelRow[]
	census: PanelBuildCensus[]
}

/**
 * Build the panel by executing the frozen selection rules.
 *
 * Strata follow the definition's order and draw from disjoint geonameid pools.
 * The builder marks each selected row as used, so later strata exclude it from eligibility.
 */
export function buildPanel(inputs: PanelBuildInputs): PanelBuildResult {
	const { definition, cities, countryNames, postcodeByAdmin, goldSets } = inputs
	const { seed, rowsPerStratum } = definition.sampling

	const byName = groupByFoldedName(cities)

	const used = new Set<string>()
	const rows: SameDataPanelRow[] = []
	const census: PanelBuildCensus[] = []

	/**
	 * Rows whose name is borne exactly once with a population above the floor.
	 * Three strata share this pool.
	 */
	const uniqueEligible = (): GeoNamesCity[] =>
		uniqueNameEligible({
			subjects: cities,
			byName,
			used,
			extra: (city) => city.population >= POPULATION_FLOOR,
		})

	const take = (
		stratum: string,
		eligible: readonly GeoNamesCity[],
		build: (city: GeoNamesCity, index: number) => StratumOutcome<SameDataPanelRow>
	): void => {
		const filled = fillStratum({
			stratum,
			eligible,
			seed,
			target: rowsPerStratum,
			identify: (city) => city.geonameid,
			used,
			build,
		})

		rows.push(...filled.rows)
		census.push(filled.census)
	}

	/**
	 * The gold set for one city, or the refusal the census counts.
	 */
	const goldFor = (city: GeoNamesCity): number[] | null => goldSets.get(city.geonameid) ?? null

	take("unambiguous", uniqueEligible(), (city, index) => {
		const gold = goldFor(city)

		if (!gold) return { outcome: "ungradeable" }

		return {
			outcome: "row",
			row: {
				id: `unambiguous-${padRowIndex(index)}`,
				stratum: "unambiguous",
				query: city.name,
				goldPresent: true,
				gold: goldOf(city, gold),
				source: { ...SOURCE },
			},
		}
	})

	// The gold alternates between the largest bearer and a smaller one.
	// The qualifier alternates between the country's English name and the bearer's admin1 code.
	const homographEligible = cities
		.filter((city) => {
			const bearers = byName.get(city.asciiname.toLowerCase())!

			if (bearers.length < 2) return false

			if (new Set(bearers.map((bearer) => bearer.country)).size < 2) return false

			const populations = bearers.map((bearer) => bearer.population).toSorted((left, right) => right - left)

			if (populations[1]! < populations[0]! * HOMOGRAPH_CONTEST_SHARE) return false

			// Only the two largest bearers need a gradeable gold because the stratum alternates between them.
			// Every other bearer is a distractor and needs no identity join.
			return bearers
				.toSorted((left, right) => right.population - left.population)
				.slice(0, 2)
				.every((bearer) => goldSets.has(bearer.geonameid))
		})
		// One row per name, keyed on the first bearer in geonameid order, so a name cannot enter the panel twice.
		.filter((city) => {
			const bearers = byName
				.get(city.asciiname.toLowerCase())!
				.toSorted((left, right) => compareByCodePoint(left.geonameid, right.geonameid))

			return bearers[0]!.geonameid === city.geonameid
		})
		.filter((city) => !used.has(city.geonameid))
		.toSorted((left, right) => compareByCodePoint(left.geonameid, right.geonameid))

	take("homograph_qualified", homographEligible, (city, index) => {
		const bearers = byName
			.get(city.asciiname.toLowerCase())!
			.toSorted((left, right) => right.population - left.population)

		const target = index % 2 === 0 ? bearers[0]! : bearers[1]!
		const gold = goldFor(target)

		if (!gold) return { outcome: "ungradeable" }

		const qualifier = index % 4 < 2 ? (countryNames.get(target.country) ?? target.country) : target.admin1

		if (!qualifier) return { outcome: "unbuildable" }

		return {
			outcome: "row",
			row: {
				id: `homograph_qualified-${padRowIndex(index)}`,
				stratum: "homograph_qualified",
				query: `${target.name}, ${qualifier}`,
				goldPresent: true,
				gold: goldOf(target, gold),
				source: { ...SOURCE },
			},
		}
	})

	take("reordered", uniqueEligible(), (city, index) => {
		const gold = goldFor(city)

		if (!gold) return { outcome: "ungradeable" }

		if (!city.admin1) return { outcome: "unbuildable" }

		return {
			outcome: "row",
			row: {
				id: `reordered-${padRowIndex(index)}`,
				stratum: "reordered",
				query: `${city.admin1} ${city.name}`,
				goldPresent: true,
				gold: goldOf(city, gold),
				source: { ...SOURCE },
			},
		}
	})

	// The register's `(country, admin1)` keys grouped once, in code-point order.
	// The same walk per row would be a re-scan of the whole index for every candidate.
	const adminKeysByCountry = new Map<string, string[]>()

	for (const key of [...postcodeByAdmin.keys()].toSorted(compareByCodePoint)) {
		const country = key.slice(0, key.indexOf("/"))
		const bucket = adminKeysByCountry.get(country) ?? []

		bucket.push(key)
		adminKeysByCountry.set(country, bucket)
	}

	take("contradictory_postcode", uniqueEligible(), (city, index) => {
		const gold = goldFor(city)

		if (!gold) return { outcome: "ungradeable" }

		const conflictingKey = adminKeysByCountry.get(city.country)?.find((key) => key !== `${city.country}/${city.admin1}`)

		const conflicting = conflictingKey ? postcodeByAdmin.get(conflictingKey) : undefined

		if (!conflicting) return { outcome: "unbuildable" }

		return {
			outcome: "row",
			row: {
				id: `contradictory_postcode-${padRowIndex(index)}`,
				stratum: "contradictory_postcode",
				query: `${city.name}, ${conflicting}`,
				goldPresent: true,
				gold: goldOf(city, gold),
				source: { ...SOURCE },
			},
		}
	})

	// The recorder reads `goldPresent: false` to determine which candidates to remove.
	// The scorer reads it to choose the denominator.
	take("gold_absent", uniqueEligible(), (city, index) => {
		const gold = goldFor(city)

		if (!gold) return { outcome: "ungradeable" }

		return {
			outcome: "row",
			row: {
				id: `gold_absent-${padRowIndex(index)}`,
				stratum: "gold_absent",
				query: city.name,
				goldPresent: false,
				gold: goldOf(city, gold),
				source: { ...SOURCE },
			},
		}
	})

	return { rows, census }
}
