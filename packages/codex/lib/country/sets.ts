// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Branded country sets, each derived from one named source.
 *
 *   A {@linkcode CountrySet} is a `ReadonlySet` of ISO 3166-1 alpha-2 codes whose type records where its members came
 *   from. The constructors here are the only code that produces one, and none of them accepts a literal list of codes:
 *   `worldCountries()` reads `CountryISO2`, `countriesOfScript()` reads the CLDR-derived `COUNTRY_SCRIPTS`,
 *   `dependentTerritories()` reads `COUNTRY_REFERENCE`, and the address-system and weights-family constructors read the table
 *   or family the caller passes from its owning package. `countriesDeclaredBy()` admits a list a file outside source
 *   declares, such as a training config's `country_weights` keys, and refuses a code `CountryISO2` lacks.
 *
 *   A signature states the set it needs, as in `trainAll(countries: CountrySet<{ world: true }>)`, so a literal
 *   `["US", "FR"]` fails to compile. The `country-literal-sets` repository check reports a cast to `CountrySet` outside
 *   this module and test files, and an array or `Set` literal of country codes held by a country-named binding.
 *
 *   Script and address system are separate axes. A script set describes the script an input is written in: RS is in both the
 *   `Latn` and `Cyrl` sets, JP in `Hani`, `Hira` and `Kana`. An address-system set selects the codex conventions that
 *   apply.
 */

import type { Tagged } from "type-fest"

import type { SystemCode } from "#address/system/code"
import { CountryISO2 } from "#country/codes"
import { OFFICIAL_LANGUAGES } from "#country/official-languages"
import { COUNTRY_REFERENCE } from "#country/reference/data"
import { COUNTRY_SCRIPTS, type ScriptCode } from "#country/writing-systems"

/**
 * The source a {@linkcode CountrySet} was derived from, or the operation that combined two sets.
 */
export type SetSpec =
	| { world: true }
	| { dependentTerritories: true }
	| { script: ScriptCode }
	| { addressSystem: SystemCode }
	| { weightsFamily: string }
	| { declaredBy: string }
	| { union: readonly [SetSpec, SetSpec] }
	| { intersect: readonly [SetSpec, SetSpec] }
	| { minus: readonly [SetSpec, SetSpec] }

/**
 * A set of ISO 3166-1 alpha-2 codes branded with the source its members came from.
 */
export type CountrySet<Spec extends SetSpec = SetSpec> = Tagged<ReadonlySet<CountryISO2>, "CountrySet", Spec>

/**
 * The fields {@linkcode countriesOfAddressSystem} reads from a model card's `address_systems` table.
 *
 * `members` maps `"<ISO 3166-1 alpha-2>/<local|latin>"` to the address-system
 * id the model was trained against.
 */
export interface AddressSystemMembership {
	members: Readonly<Record<string, number>>
}

/**
 * The fields {@linkcode countriesOfWeightsFamily} reads from a weights family declaration.
 */
export interface WeightsFamilyMembership<Family extends string = string> {
	family: Family
	/**
	 * BCP 47 locales such as `ja-jp`, or a bare family id such as `cjk`.
	 */
	locales: readonly string[]
	/**
	 * Language subtags the family serves beyond its locales.
	 */
	languages?: readonly string[]
}

const ISO2_CODES: ReadonlySet<string> = new Set<string>(Object.values(CountryISO2))

/**
 * Brands a set this module derived.
 */
function brand<Spec extends SetSpec>(members: Iterable<CountryISO2>): CountrySet<Spec> {
	return new Set(members) as unknown as CountrySet<Spec>
}

/**
 * The ISO 3166-1 codes among `codes`, in their order.
 */
function isoCodes(codes: Iterable<string>): CountryISO2[] {
	return [...codes].filter((code): code is CountryISO2 => ISO2_CODES.has(code))
}

/**
 * Returns whether `code` belongs to `set`, for a caller holding an unvalidated string.
 */
export function hasCountry(set: CountrySet, code: string | null | undefined): boolean {
	return typeof code === "string" && (set as ReadonlySet<string>).has(code)
}

/**
 * Every ISO 3166-1 alpha-2 code in `CountryISO2`, dependencies and territories included.
 */
export function worldCountries(): CountrySet<{ world: true }> {
	return brand(Object.values(CountryISO2))
}

/**
 * The codes `COUNTRY_REFERENCE` marks as a dependency or territory.
 *
 * The sovereign states are `minus(worldCountries(), dependentTerritories())`.
 */
export function dependentTerritories(): CountrySet<{ dependentTerritories: true }> {
	return brand(isoCodes(Object.keys(COUNTRY_REFERENCE)).filter((code) => COUNTRY_REFERENCE[code]?.dependency))
}

/**
 * The countries where `script` writes an official language, read from `COUNTRY_SCRIPTS`.
 *
 * A country can belong to several script sets.
 */
export function countriesOfScript<Script extends ScriptCode>(script: Script): CountrySet<{ script: Script }> {
	return brand(isoCodes(Object.keys(COUNTRY_SCRIPTS)).filter((code) => COUNTRY_SCRIPTS[code]!.includes(script)))
}

/**
 * The countries a model card's `address_systems` table assigns to the same system as `system`'s own country.
 *
 * A codex system code is its country's lowercase code, so `"us"` reads the id of `US/local`
 * and collects every country with a `local` or `latin` member of that id.
 *
 * @throws When the table has no `local` member for the system's country.
 * An empty set would misreport that table as a system with no countries.
 */
export function countriesOfAddressSystem<System extends SystemCode>(
	system: System,
	table: AddressSystemMembership
): CountrySet<{ addressSystem: System }> {
	const anchor = `${system.toUpperCase()}/local`
	const id = table.members[anchor]

	if (typeof id !== "number") {
		throw new TypeError(`The address_systems table has no ${anchor} member, so system "${system}" has no id to match.`)
	}

	const countries = Object.entries(table.members)
		.filter(([, member]) => member === id)
		.map(([key]) => key.split("/")[0]!)

	return brand(isoCodes(new Set(countries)))
}

/**
 * The countries a weights family serves: each locale's region, and every country where a
 * locale's language or one of the family's `languages` is official in `OFFICIAL_LANGUAGES`.
 *
 * The family is passed in from `FAMILIES` in `@mailwoman/neural`, which depends on this package.
 */
export function countriesOfWeightsFamily<Family extends string>(
	family: WeightsFamilyMembership<Family>
): CountrySet<{ weightsFamily: Family }> {
	const regions = new Set<string>()
	const languages = new Set<string>(family.languages)

	for (const locale of family.locales) {
		const [language, region] = locale.split("-")

		if (region) {
			regions.add(region.toUpperCase())
			languages.add(language!.toLowerCase())
		}
	}

	for (const [code, entry] of Object.entries(OFFICIAL_LANGUAGES)) {
		if (entry.official.some((language) => languages.has(language))) {
			regions.add(code)
		}
	}

	return brand(isoCodes([...regions].toSorted()))
}

/**
 * The codes a named declaration lists, such as a training config's `country_weights` keys.
 *
 * `source` names the declaration in the brand and in a refusal.
 *
 * @throws When a code is not an ISO 3166-1 alpha-2 code in `CountryISO2`.
 */
export function countriesDeclaredBy<Source extends string>(
	source: Source,
	codes: Iterable<string>
): CountrySet<{ declaredBy: Source }> {
	const listed = [...codes]
	const unknown = listed.filter((code) => !ISO2_CODES.has(code))

	if (unknown.length) {
		throw new TypeError(`${source} lists codes that are not ISO 3166-1 alpha-2 countries: ${unknown.join(", ")}`)
	}

	return brand(listed as CountryISO2[])
}

/**
 * The members of either set.
 */
export function union<A extends SetSpec, B extends SetSpec>(
	a: CountrySet<A>,
	b: CountrySet<B>
): CountrySet<{ union: readonly [A, B] }> {
	return brand([...a, ...b])
}

/**
 * The members of both sets, in `a`'s order.
 */
export function intersect<A extends SetSpec, B extends SetSpec>(
	a: CountrySet<A>,
	b: CountrySet<B>
): CountrySet<{ intersect: readonly [A, B] }> {
	return brand([...a].filter((code) => b.has(code)))
}

/**
 * The members of `a` that are not in `b`.
 */
export function minus<A extends SetSpec, B extends SetSpec>(
	a: CountrySet<A>,
	b: CountrySet<B>
): CountrySet<{ minus: readonly [A, B] }> {
	return brand([...a].filter((code) => !b.has(code)))
}
