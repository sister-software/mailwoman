/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The panel builder for the same-data benchmark (#2261): it executes the frozen selection rules over
 *   GeoNames and emits the rows, and it contains no judgement of its own.
 *
 *   Eligibility, query construction, gold, fill order and the sampling seed all come from
 *   `benchmark-definition.json`, committed before any row was inspected. This module is the executable form
 *   of those rules, so a change to what it selects is a change to the definition, which bumps the version
 *   and the content hash.
 *
 *   A row's entity, name, coordinate and population come from `cities15000.txt` under CC-BY-4.0;
 *   `readGoldSets` turns the geonameid into the ids the candidate backend answers with. A geonameid whose
 *   join is not coherent is dropped before sampling with the count reported, because that count describes
 *   the gazetteer and reporting it keeps a coverage hole from reading as a panel choice.
 *
 *   Half the homograph rows name a bearer that is not the most populous. A panel whose gold is always the
 *   largest bearer would be satisfied by a population prior alone, and that prior is under test.
 */

import { SeededRandom } from "@mailwoman/core/random"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { GEONAMES_MAIN_COLUMNS } from "@mailwoman/corpus/adapters/geonames/adapter"
import { GEONAMES_POSTAL_COLUMNS } from "@mailwoman/corpus/adapters/geonames/postal/adapter"
import { TSVSpliterator } from "spliterator"

import type { SameDataBenchmarkDefinition } from "#eval-harness/same-data/definition"
import type { SameDataPanelRow } from "#eval-harness/same-data/fixture"

/**
 * The provenance every panel row carries.
 */
const SOURCE = { register: "geonames:cities15000", license: "CC-BY-4.0", attribution: "GeoNames" } as const

/**
 * The population floor the unambiguous rule registers.
 */
const POPULATION_FLOOR = 50_000

/**
 * The homograph rule's contest floor: the runner-up must hold at least this share of the largest bearer's population,
 * so the pair is a real contest rather than a formality.
 */
const HOMOGRAPH_CONTEST_SHARE = 1 / 3

/**
 * `countryInfo.txt` column indices (0-based): ISO alpha-2 and the register's English short country name.
 */
const COUNTRY_INFO_COLUMNS = { iso: 0, country: 4 } as const

/**
 * The postal dump's admin1 CODE column. `@mailwoman/corpus`'s {@link GEONAMES_POSTAL_COLUMNS} names the admin1 NAME at
 * index 3 because that is what a corpus row renders; this panel keys on the code beside it, which is stable across the
 * register's language variants.
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
 * Parse a GeoNames main-table dump. This benchmark reads `cities15000.txt`, the table filtered to places above 15,000
 * population; a per-country dump (`FR.txt`) carries the same columns and parses here unchanged, which is what a panel
 * reaching below that floor would read. `header: false`: the dump is headerless, and a spliterator that assumed one
 * would eat the first row.
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
 * The English short country names, read from `countryInfo.txt` — the register's own column, so a country qualifier is
 * spelled the way the gold source spells it rather than the way this file would.
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
 * FIRST rather than random: the register's order is the register's, and taking the first makes the choice a property of
 * the source instead of a second seeded draw nobody registered. The file carries 1.8 million rows, so it is streamed
 * and only the index is held.
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
 * A seeded Fisher-Yates over a copy, so the caller's array is untouched and two runs draw identically.
 *
 * The ORDER this returns is load-bearing: it selects which rows entered the frozen panel, whose digest the published
 * record names. `SeededRandom.shuffle` reproduces it exactly — verified identical over sizes 24, 1,000, 10,932 (the
 * panel's own eligible-pool size) and 100,000, at seeds 1, 7, 20260913 and 4294967295 — so this wraps the shared home
 * rather than re-typing the loop beside it.
 */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const shuffled = [...items]

	new SeededRandom(seed).shuffle(shuffled)

	return shuffled
}

/**
 * What the build dropped and why — reported beside the panel, never folded into it.
 */
export interface PanelBuildCensus {
	stratum: string
	eligible: number
	selected: number
	/**
	 * Rows skipped because the identity join produced no coherent gold set. `readGoldSets`'s own census says WHICH part
	 * of the guard refused them.
	 */
	droppedUngradeableGold: number
	/**
	 * Rows the stratum's own rule could not render: no admin1 code, no country name, or no conflicting postcode in the
	 * register. Counted apart from the gold drop because the two name different holes — one in the gazetteer, one in the
	 * source register.
	 */
	droppedUnbuildable: number
}

export interface PanelBuildInputs {
	definition: SameDataBenchmarkDefinition
	cities: readonly GeoNamesCity[]
	countryNames: ReadonlyMap<string, string>
	postcodeByAdmin: ReadonlyMap<string, string>
	/**
	 * Geonameid → the coherent gold identity set, from `readGoldSets`. A geonameid absent from this map is ungradeable
	 * and can never enter the panel.
	 */
	goldSets: ReadonlyMap<string, number[]>
}

export interface PanelBuildResult {
	rows: SameDataPanelRow[]
	census: PanelBuildCensus[]
}

function goldOf(city: GeoNamesCity, placeIDs: number[]): SameDataPanelRow["gold"] {
	return {
		geonameid: city.geonameid,
		placeIDs,
		name: city.name,
		country: city.country,
		admin1: city.admin1,
		lat: city.lat,
		lon: city.lon,
		population: city.population,
	}
}

/**
 * Build the panel by executing the frozen selection rules.
 *
 * Strata are filled in the definition's order and draw from disjoint geonameid pools: every row a stratum takes is
 * marked used, and a later stratum's eligibility excludes it.
 */
export function buildPanel(inputs: PanelBuildInputs): PanelBuildResult {
	const { definition, cities, countryNames, postcodeByAdmin, goldSets } = inputs
	const { seed, rowsPerStratum } = definition.sampling

	const byName = new Map<string, GeoNamesCity[]>()

	for (const city of cities) {
		const key = city.asciiname.toLowerCase()
		const bucket = byName.get(key) ?? []

		bucket.push(city)
		byName.set(key, bucket)
	}

	const used = new Set<string>()
	const rows: SameDataPanelRow[] = []
	const census: PanelBuildCensus[] = []

	/**
	 * Rows whose name is borne exactly once, above the population floor — the pool three strata share.
	 */
	const uniqueEligible = (): GeoNamesCity[] =>
		cities
			.filter((city) => byName.get(city.asciiname.toLowerCase())!.length === 1)
			.filter((city) => city.population >= POPULATION_FLOOR)
			.filter((city) => !used.has(city.geonameid))
			.toSorted((left, right) => compareByCodePoint(left.geonameid, right.geonameid))

	/**
	 * What a stratum's own rule made of one eligible row. A stratum decides for itself whether its gold is gradeable,
	 * because the gold is not always the row being iterated — the homograph rule alternates between two bearers, and a
	 * check against the iterated one refuses rows whose actual gold is fine.
	 */
	type BuildOutcome =
		| { readonly outcome: "row"; readonly row: SameDataPanelRow }
		| { readonly outcome: "ungradeable" }
		| { readonly outcome: "unbuildable" }

	const take = (
		stratum: string,
		eligible: readonly GeoNamesCity[],
		build: (city: GeoNamesCity, index: number) => BuildOutcome
	): void => {
		const shuffled = seededShuffle(eligible, seed)
		let selected = 0
		let droppedUngradeableGold = 0
		let droppedUnbuildable = 0

		for (const city of shuffled) {
			if (selected >= rowsPerStratum) break

			const built = build(city, selected)

			if (built.outcome === "ungradeable") {
				droppedUngradeableGold++

				continue
			}

			if (built.outcome === "unbuildable") {
				droppedUnbuildable++

				continue
			}

			rows.push(built.row)
			used.add(city.geonameid)

			selected++
		}

		census.push({ stratum, eligible: eligible.length, selected, droppedUngradeableGold, droppedUnbuildable })
	}

	/**
	 * The gold set for one city, or the refusal the census counts.
	 */
	const goldFor = (city: GeoNamesCity): number[] | null => goldSets.get(city.geonameid) ?? null

	const pad = (index: number): string => String(index + 1).padStart(3, "0")

	// Stratum 1 — the bare toponym, one bearer.
	take("unambiguous", uniqueEligible(), (city, index) => {
		const gold = goldFor(city)

		if (!gold) return { outcome: "ungradeable" }

		return {
			outcome: "row",
			row: {
				id: `unambiguous-${pad(index)}`,
				stratum: "unambiguous",
				query: city.name,
				goldPresent: true,
				gold: goldOf(city, gold),
				source: { ...SOURCE },
			},
		}
	})

	// Stratum 2 — a qualified homograph. The gold alternates between the largest bearer and a smaller one, and the
	// qualifier alternates between the country's English name and the bearer's admin1 code.
	const homographEligible = cities
		.filter((city) => {
			const bearers = byName.get(city.asciiname.toLowerCase())!

			if (bearers.length < 2) return false

			if (new Set(bearers.map((bearer) => bearer.country)).size < 2) return false

			const populations = bearers.map((bearer) => bearer.population).toSorted((left, right) => right - left)

			if (populations[1]! < populations[0]! * HOMOGRAPH_CONTEST_SHARE) return false

			// Only the two largest bearers need a gradeable gold: the stratum's gold alternates between them, and every
			// other bearer is a distractor, which needs no identity join to distract.
			return bearers
				.toSorted((left, right) => right.population - left.population)
				.slice(0, 2)
				.every((bearer) => goldSets.has(bearer.geonameid))
		})
		// One row per NAME, keyed on the first bearer in geonameid order, so a name cannot enter the panel twice.
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
				id: `homograph_qualified-${pad(index)}`,
				stratum: "homograph_qualified",
				query: `${target.name}, ${qualifier}`,
				goldPresent: true,
				gold: goldOf(target, gold),
				source: { ...SOURCE },
			},
		}
	})

	// Stratum 3 — the same unique-name pool, rendered reversed with the comma removed.
	take("reordered", uniqueEligible(), (city, index) => {
		const gold = goldFor(city)

		if (!gold) return { outcome: "ungradeable" }

		if (!city.admin1) return { outcome: "unbuildable" }

		return {
			outcome: "row",
			row: {
				id: `reordered-${pad(index)}`,
				stratum: "reordered",
				query: `${city.admin1} ${city.name}`,
				goldPresent: true,
				gold: goldOf(city, gold),
				source: { ...SOURCE },
			},
		}
	})

	// The register's `(country, admin1)` keys grouped once, in code-point order — the same walk per row would be a
	// re-scan of the whole index for every candidate.
	const adminKeysByCountry = new Map<string, string[]>()

	for (const key of [...postcodeByAdmin.keys()].toSorted(compareByCodePoint)) {
		const country = key.slice(0, key.indexOf("/"))
		const bucket = adminKeysByCountry.get(country) ?? []

		bucket.push(key)
		adminKeysByCountry.set(country, bucket)
	}

	// Stratum 4 — the name paired with a postcode from a different region of the same country.
	take("contradictory_postcode", uniqueEligible(), (city, index) => {
		const gold = goldFor(city)

		if (!gold) return { outcome: "ungradeable" }

		const conflictingKey = adminKeysByCountry.get(city.country)?.find((key) => key !== `${city.country}/${city.admin1}`)

		const conflicting = conflictingKey ? postcodeByAdmin.get(conflictingKey) : undefined

		if (!conflicting) return { outcome: "unbuildable" }

		return {
			outcome: "row",
			row: {
				id: `contradictory_postcode-${pad(index)}`,
				stratum: "contradictory_postcode",
				query: `${city.name}, ${conflicting}`,
				goldPresent: true,
				gold: goldOf(city, gold),
				source: { ...SOURCE },
			},
		}
	})

	// Stratum 5 — the bare toponym again, with the gold withheld from the fixture after recording. `goldPresent: false`
	// is what the recorder reads to know which candidates to remove, and what the scorer reads to pick the denominator.
	take("gold_absent", uniqueEligible(), (city, index) => {
		const gold = goldFor(city)

		if (!gold) return { outcome: "ungradeable" }

		return {
			outcome: "row",
			row: {
				id: `gold_absent-${pad(index)}`,
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
