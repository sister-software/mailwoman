// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The absent-verdict and explicit-scope cases are the interface.
 *
 *   An absent verdict stays unknown. and an explicit caller scope is never second-guessed here.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import {
	type DefaultCountry,
	EMPTY_PLACE_FIELDS,
	type ResolvedPlace,
	type ResolverBackend,
	ScopeStrength,
} from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { resolverDefaultCountry } from "#country-scope"
import {
	type CountryScopeEvidence,
	decideCountryScope,
	inferredScopeYieldsOnMiss,
	ScopeWithheldReason,
} from "#inferred-scope"

type LocaleVerdict = NonNullable<AddressTree["localeCountry"]>

function node(tag: AddressNode["tag"], value: string): AddressNode {
	return { tag, value, start: 0, end: value.length, confidence: 1, children: [] }
}

function tree(localeCountry?: LocaleVerdict, roots: AddressNode[] = []): AddressTree {
	return { raw: "x", roots, ...(localeCountry ? { localeCountry } : {}) }
}

const INFERRED_US = { country: "US", source: "inferred" } as const
const CALLER_US = { country: "US", source: "caller" } as const

const NO_EVIDENCE: CountryScopeEvidence = { formatCountries: [], softWhenWithheld: false, scopeCountryRetrieval: false }

/**
 * Whether the decision keeps `scope` from the resolver, given the locale head and the postcode format.
 */
async function dropsScope(
	address: AddressTree,
	scope: DefaultCountry,
	formatCountries: readonly string[] = []
): Promise<boolean> {
	const decision = await decideCountryScope(address, scope, { ...NO_EVIDENCE, formatCountries })

	return decision.resolver === null
}

function place(name: string, country: string, population: number, importance: number): ResolvedPlace {
	return {
		...EMPTY_PLACE_FIELDS,
		id: `${name}-${country}`,
		name,
		placetype: "locality",
		country,
		lat: 0,
		lon: 0,
		score: Math.log10(population),
		population,
		importance,
		exactMatch: true,
	}
}

/**
 * A gazetteer lookup over `places`, largest first, filtered by the query's country.
 */
function gazetteer(places: ResolvedPlace[]): ResolverBackend["findPlace"] {
	return async (query) =>
		places
			.filter((candidate) => !query.country || candidate.country === query.country)
			.toSorted((a, b) => b.score - a.score)
			.slice(0, query.limit ?? places.length)
}

const MONTREAL_CA = place("Montreal", "CA", 1_600_000, 0.76)
const MONTREAL_US = place("Montreal", "US", 794, 0.31)

const STREET_IN_MONTREAL = [
	node("house_number", "1001"),
	node("street", "Boulevard Saint-Laurent"),
	node("locality", "Montréal"),
]

describe("decideCountryScope on the locale head and the postcode format (#1684)", () => {
	it("drops an inferred scope on a confident CONTRARY read — the Nanjing/Chat-qui-Pêche class", async () => {
		expect(await dropsScope(tree({ country: "GB", confidence: 1 }), INFERRED_US)).toBe(true)
		expect(await dropsScope(tree({ country: "FR", confidence: 0.99 }), INFERRED_US)).toBe(true)
	})

	it("keeps the scope when the head agrees with it, as for 75001, a postcode in Paris and in Texas", async () => {
		expect(await dropsScope(tree({ country: "US", confidence: 1 }), INFERRED_US)).toBe(false)
		expect(await dropsScope(tree({ country: "us", confidence: 1 }), INFERRED_US)).toBe(false)
	})

	it("keeps the scope on an ABSENT verdict — unknown is not foreign (the Sacremento protection)", async () => {
		expect(await dropsScope(tree(), INFERRED_US)).toBe(false)
	})

	it("never touches an EXPLICIT scope, whatever the head says", async () => {
		expect(await dropsScope(tree({ country: "FR", confidence: 1 }), CALLER_US)).toBe(false)
	})

	it("drops on a postcode FORMAT that excludes the inferred country — the A1V 0A9 Gander class", async () => {
		expect(await dropsScope(tree(), INFERRED_US, ["CA"])).toBe(true)
	})

	it("keeps the scope when the format set includes the inferred country, as a five-digit postcode does", async () => {
		expect(await dropsScope(tree(), INFERRED_US, ["US", "FR", "DE"])).toBe(false)
	})

	it("an empty format set is silence, not foreignness", async () => {
		expect(await dropsScope(tree(), INFERRED_US, [])).toBe(false)
	})

	it("the format signal never overrides an EXPLICIT scope either", async () => {
		expect(await dropsScope(tree(), CALLER_US, ["CA"])).toBe(false)
	})
})

describe("An inferred country the locale head has no class for", () => {
	const INFERRED_NZ = { country: "NZ", source: "inferred" } as const
	const INFERRED_AU = { country: "AU", source: "inferred" } as const

	it("keeps the scope when the head names a country of the same codex address system", async () => {
		expect(await dropsScope(tree({ country: "GB", confidence: 0.92 }), INFERRED_NZ)).toBe(false)
	})

	it("drops the scope when the head names a country of a different address system", async () => {
		expect(await dropsScope(tree({ country: "US", confidence: 0.95 }), INFERRED_NZ)).toBe(true)
		expect(await dropsScope(tree({ country: "DE", confidence: 0.95 }), INFERRED_NZ)).toBe(true)
		expect(await dropsScope(tree({ country: "GB", confidence: 0.95 }), INFERRED_AU)).toBe(true)
	})

	it("still drops an inferred scope the head has a class for on any contrary country", async () => {
		expect(await dropsScope(tree({ country: "CZ", confidence: 1 }), INFERRED_US)).toBe(true)
		expect(await dropsScope(tree({ country: "CA", confidence: 1 }), INFERRED_US)).toBe(true)
	})

	it("reads the postcode-format signal unchanged", async () => {
		expect(await dropsScope(tree({ country: "GB", confidence: 0.92 }), INFERRED_NZ, ["GB"])).toBe(true)
		expect(await dropsScope(tree({ country: "GB", confidence: 0.92 }), INFERRED_NZ, ["NZ", "AU"])).toBe(false)
	})
})

describe("CLI country scope reaches the decision with its true source", () => {
	it("a --locale country is inferred, so a contrary read withholds it", async () => {
		const scope = resolverDefaultCountry({ locale: "en-US" })

		expect(scope).toEqual(INFERRED_US)
		expect(await dropsScope(tree({ country: "FR", confidence: 1 }), scope!)).toBe(true)
	})

	it("a --default-country is the caller's, so a contrary read keeps it", async () => {
		const scope = resolverDefaultCountry({ defaultCountry: "US", locale: "fr-FR" })

		expect(scope).toEqual(CALLER_US)
		expect(await dropsScope(tree({ country: "FR", confidence: 1 }), scope!)).toBe(false)
	})
})

describe("decideCountryScope on the whole input's shape", () => {
	it("withholds an inferred scope for a bare place name and states the reason", async () => {
		const decision = await decideCountryScope(tree(undefined, [node("locality", "Paris")]), INFERRED_US, NO_EVIDENCE)

		expect(decision).toEqual({ resolver: null, withheld: { country: "US", reason: ScopeWithheldReason.BareLocality } })
	})

	it("keeps the withheld country as a soft scope when the caller asks for the prior", async () => {
		const decision = await decideCountryScope(tree(undefined, [node("locality", "Paris")]), INFERRED_US, {
			...NO_EVIDENCE,
			softWhenWithheld: true,
		})

		expect(decision.resolver).toEqual({ country: "US", source: "inferred", strength: ScopeStrength.Soft })
		expect(decision.withheld?.reason).toBe(ScopeWithheldReason.BareLocality)
	})

	it("withholds for a bare postcode only when its format excludes the country", async () => {
		const bare = tree(undefined, [node("postcode", "SW1A 1AA")])
		const conflict = await decideCountryScope(bare, INFERRED_US, { ...NO_EVIDENCE, formatCountries: ["GB"] })
		const ambiguous = await decideCountryScope(bare, INFERRED_US, { ...NO_EVIDENCE, formatCountries: ["US", "FR"] })

		expect(conflict.withheld?.reason).toBe(ScopeWithheldReason.BarePostcodeFormatConflict)
		expect(ambiguous).toEqual({ resolver: INFERRED_US, withheld: null })
	})
})

describe("decideCountryScope on a larger namesake abroad", () => {
	const evidence = (places: ResolvedPlace[]): CountryScopeEvidence => ({ ...NO_EVIDENCE, findPlace: gazetteer(places) })

	it("withholds the scope when the namesake abroad outranks the country's own beyond the bonus", async () => {
		const decision = await decideCountryScope(
			tree(undefined, STREET_IN_MONTREAL),
			INFERRED_US,
			evidence([MONTREAL_CA, MONTREAL_US])
		)

		expect(decision).toEqual({
			resolver: null,
			withheld: { country: "US", reason: ScopeWithheldReason.LargerNamesakeAbroad },
		})
	})

	it("withholds the scope when the name has zero match inside the country", async () => {
		const decision = await decideCountryScope(tree(undefined, STREET_IN_MONTREAL), INFERRED_US, evidence([MONTREAL_CA]))

		expect(decision.withheld?.reason).toBe(ScopeWithheldReason.LargerNamesakeAbroad)
	})

	it("keeps the scope when the country's own namesake is within the bonus and as important", async () => {
		const abroad = place("Springfield", "CA", 16_000, 0.3)
		const home = place("Springfield", "US", 9000, 0.5)
		const address = tree(undefined, [node("street", "Main Street"), node("locality", "Springfield")])

		expect(await decideCountryScope(address, INFERRED_US, evidence([abroad, home]))).toEqual({
			resolver: INFERRED_US,
			withheld: null,
		})
	})

	it("keeps the scope when the locale head reads the address as the country's", async () => {
		const decision = await decideCountryScope(
			tree({ country: "US", confidence: 0.97 }, STREET_IN_MONTREAL),
			INFERRED_US,
			evidence([MONTREAL_CA, MONTREAL_US])
		)

		expect(decision).toEqual({ resolver: INFERRED_US, withheld: null })
	})

	it("never withholds a caller's scope", async () => {
		const decision = await decideCountryScope(
			tree(undefined, STREET_IN_MONTREAL),
			CALLER_US,
			evidence([MONTREAL_CA, MONTREAL_US])
		)

		expect(decision).toEqual({ resolver: CALLER_US, withheld: null })
	})
})

describe("inferredScopeYieldsOnMiss", () => {
	const filtering = { resolver: INFERRED_US, withheld: null }

	it("yields an inferred filter the locale head didn't confirm", () => {
		expect(inferredScopeYieldsOnMiss(tree(), filtering)).toBe(true)
	})

	it("keeps an inferred filter the locale head confirms, as for a military address with zero gazetteer match", () => {
		expect(inferredScopeYieldsOnMiss(tree({ country: "US", confidence: 1 }), filtering)).toBe(false)
	})

	it("keeps a caller's filter and a soft scope", () => {
		const soft = { country: "US", source: "inferred", strength: ScopeStrength.Soft } as const

		expect(inferredScopeYieldsOnMiss(tree(), { resolver: CALLER_US, withheld: null })).toBe(false)
		expect(inferredScopeYieldsOnMiss(tree(), { resolver: soft, withheld: null })).toBe(false)
	})
})
