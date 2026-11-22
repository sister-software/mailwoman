// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The country-scope decision of one geocode: whether the scope a caller or a locale
 * supplied reaches the resolver as a filter, as a ranking preference, or is withheld.
 *
 * Only a locale-inferred scope ever yields, and it yields only to evidence in the address.
 * A caller's scope passes through unchanged.
 *
 * The locale head's country is evidence the text is foreign-shaped, never a resolved country.
 */

import { addressSystemKey, layoutForCountry } from "@mailwoman/codex/address/layouts"
import type { AddressTree } from "@mailwoman/core/decoder"
import { firstNodeWhere } from "@mailwoman/core/decoder"
import { isBareLocalityTree, isBarePostcodeTree } from "@mailwoman/core/pipeline"
import { type DefaultCountry, type ResolverBackend, ScopeStrength } from "@mailwoman/core/resolver"
import { LOCALE_COUNTRIES } from "@mailwoman/neural/labels"
import { type CapitalLevelFn, promoteScopedCountry } from "@mailwoman/resolver/toponym-prior"

/**
 * Why a locale-inferred country scope didn't reach the resolver as a filter.
 *
 * - `"bare_locality"`: the whole input is one place name.
 * - `"bare_postcode_format_conflict"`: the whole input is one postcode,
 *   in a format the country doesn't use.
 * - `"contradicting_evidence"`: the locale head reads the address as another country's,
 *   or the postcode's format excludes the country.
 * - `"larger_namesake_abroad"`: the gazetteer's leading place of the parsed locality's name is in another
 *   country, and the soft scope's bounded bonus doesn't move the country's own namesake above it.
 * - `"no_match_in_country"`: the address resolved to zero coordinates inside the country,
 *   and the locale head didn't read it as that country's.
 */
export const ScopeWithheldReason = {
	BareLocality: "bare_locality",
	BarePostcodeFormatConflict: "bare_postcode_format_conflict",
	ContradictingEvidence: "contradicting_evidence",
	LargerNamesakeAbroad: "larger_namesake_abroad",
	NoMatchInCountry: "no_match_in_country",
} as const

export type ScopeWithheldReason = (typeof ScopeWithheldReason)[keyof typeof ScopeWithheldReason]

/**
 * The country scope one geocode resolves under.
 */
export interface CountryScopeDecision {
	/**
	 * The scope the resolver is given, or null when it resolves with none.
	 */
	resolver: DefaultCountry | null

	/**
	 * The locale's country, when evidence in the address kept it from filtering.
	 *
	 * {@linkcode resolver} is then a soft scope standing in for it, or null.
	 */
	withheld: { country: string; reason: ScopeWithheldReason } | null
}

/**
 * What {@linkcode decideCountryScope} reads beside the parsed address.
 */
export interface CountryScopeEvidence {
	/**
	 * The countries the address's postcode format implies, empty when the format is ambiguous or absent.
	 */
	formatCountries: readonly string[]

	/**
	 * Whether a withheld locale country stays with the resolver as a soft scope.
	 */
	softWhenWithheld: boolean

	/**
	 * Whether a soft scope acts inside retrieval.
	 *
	 * The locale head's contradicting country then stands in for a scope it contradicts.
	 */
	scopeCountryRetrieval: boolean

	/**
	 * The gazetteer lookup the namesake rule probes, absent when the resolver offers none.
	 */
	findPlace?: ResolverBackend["findPlace"]

	/**
	 * The soft scope's bonus in log10-population units, the resolver's default when absent.
	 */
	softCountryWeight?: number

	/**
	 * The capital status of a place.
	 * A national capital stays above a promoted namesake.
	 */
	capitalLevel?: CapitalLevelFn
}

/**
 * The countries the locale head has a class for.
 */
const LOCALE_HEAD_COUNTRIES: ReadonlySet<string> = new Set(LOCALE_COUNTRIES)

/**
 * Returns the codex address-system key of a country's default layout, or null
 * when codex has no layout for it.
 */
function addressSystemOf(country: string): string | null {
	const layout = layoutForCountry(country)

	return layout ? addressSystemKey(layout) : null
}

/**
 * Returns whether the locale head's country is evidence against the inferred country.
 *
 * A head with a class for the inferred country would have read that class,
 * so any other country contradicts it.
 * A head without that class reads the text as the nearest class it has.
 *
 * Its verdict then contradicts the inferred country only when the codex address systems of the two differ.
 * The head reads a New Zealand address as GB, and codex gives NZ and GB the same component order.
 */
function verdictContradicts(verdict: string, inferred: string): boolean {
	if (verdict === inferred) return false

	if (LOCALE_HEAD_COUNTRIES.has(inferred)) return true

	const verdictSystem = addressSystemOf(verdict)

	return verdictSystem === null || verdictSystem !== addressSystemOf(inferred)
}

/**
 * Whether the address's own evidence points away from a locale-inferred `scope`,
 * on either of two independent signals.
 *
 * The locale head reads the text as a different country's addressing, or the postcode's
 * format implies a country set that excludes the inferred country.
 * The head's verdict counts only under the rule in {@link verdictContradicts}.
 *
 * The format signal speaks only on distinctive shapes, so an ambiguous bare 5-digit
 * postcode yields the empty set and keeps the scope.
 *
 * An absent verdict on both signals keeps the scope: unknown isn't foreign.
 */
function evidenceContradicts(tree: AddressTree, scope: DefaultCountry, formatCountries: readonly string[]): boolean {
	const inferred = scope.country.toUpperCase()
	const verdict = tree.localeCountry

	if (verdict && verdictContradicts(verdict.country.toUpperCase(), inferred)) return true

	return formatCountries.length > 0 && !formatCountries.some((country) => country.toUpperCase() === inferred)
}

/**
 * The soft scope that stands in for a dropped inferred scope: the locale head's country,
 * when the head's verdict is what contradicts the inferred country.
 *
 * It returns null when the head gave no verdict or agrees with the inferred country,
 * so a scope the postcode format dropped while the head agreed gets no stand-in.
 */
function softScopeFromLocaleHead(tree: AddressTree, scope: DefaultCountry): DefaultCountry | null {
	const verdict = tree.localeCountry?.country.toUpperCase()

	if (!verdict || !verdictContradicts(verdict, scope.country.toUpperCase())) return null

	return { country: verdict, source: "inferred", strength: ScopeStrength.Soft }
}

/**
 * Whether the locale head read the address as the scope's own country.
 *
 * The head's agreement is the address's own evidence for the scope, so neither the
 * namesake rule nor a miss inside the country withholds a scope the head confirms.
 */
function localeHeadConfirms(tree: AddressTree, scope: DefaultCountry): boolean {
	return tree.localeCountry?.country.toUpperCase() === scope.country.toUpperCase()
}

/**
 * Whether the parsed locality's name belongs to a place abroad that the scope's
 * own namesake doesn't displace.
 *
 * The gazetteer's leading exact match for the name is compared with the leading match inside the
 * scope's country under {@linkcode promoteScopedCountry}, the bounded bonus a soft scope gives.
 * The scope's namesake therefore still leads when it is within the bonus of the
 * place abroad, and Montréal, Québec leads Montreal, Wisconsin.
 *
 * A name with zero match inside the country, and a leading match abroad, also counts.
 */
async function largerNamesakeAbroad(
	tree: AddressTree,
	scope: DefaultCountry,
	evidence: CountryScopeEvidence
): Promise<boolean> {
	const locality = firstNodeWhere(tree.roots, (node) => node.tag === "locality")?.value

	if (!locality || !evidence.findPlace) return false

	const query = { text: locality, placetype: "locality", limit: 1 }
	const [leading] = await evidence.findPlace(query)
	const country = scope.country.toUpperCase()

	if (!leading?.country || leading.exactMatch === false || leading.country.toUpperCase() === country) return false

	const [namesake] = await evidence.findPlace({ ...query, country: scope.country })

	if (!namesake) return true

	const ranked = promoteScopedCountry(
		[leading, namesake],
		scope.country,
		evidence.softCountryWeight,
		evidence.capitalLevel
	)

	return ranked[0] === leading
}

/**
 * The reason the shape of the whole input withholds a locale-inferred hard scope, or null.
 */
function wholeInputReason(
	tree: AddressTree,
	scope: DefaultCountry,
	formatCountries: readonly string[]
): ScopeWithheldReason | null {
	if (isBareLocalityTree(tree)) return ScopeWithheldReason.BareLocality

	const conflicts = formatCountries.length > 0 && !formatCountries.includes(scope.country)

	return isBarePostcodeTree(tree) && conflicts ? ScopeWithheldReason.BarePostcodeFormatConflict : null
}

/**
 * Decides the country scope the resolver gets for one parsed address.
 *
 * A caller's scope is returned as given.
 * A locale-inferred scope filters unless the address shows evidence against it, in this order:
 *
 * 1. The whole input is one place name, or one postcode in a format the country doesn't use.
 * 2. The locale head reads another country's addressing, or the postcode format excludes the country.
 * 3. The parsed locality's leading namesake is abroad and outranks the country's own under
 *    the soft scope's bonus, while the locale head hasn't read the address as the country's.
 *
 * Under rule 1 or 3 the country stays as a soft scope when `softWhenWithheld` is set.
 * Under rule 2 the locale head's country stands in as a soft scope when `scopeCountryRetrieval` is set.
 *
 * An inferred soft scope is subject to rule 2 only, and only under `scopeCountryRetrieval`.
 *
 * {@linkcode inferredScopeYieldsOnMiss} states the fourth case.
 * That case is known only after a resolve.
 */
export async function decideCountryScope(
	tree: AddressTree,
	scope: DefaultCountry | null,
	evidence: CountryScopeEvidence
): Promise<CountryScopeDecision> {
	if (scope?.source !== "inferred") return { resolver: scope, withheld: null }

	const softStandIn = (): DefaultCountry | null =>
		evidence.softWhenWithheld ? { country: scope.country, source: "inferred", strength: ScopeStrength.Soft } : null

	let resolver: DefaultCountry | null = scope
	let withheld: CountryScopeDecision["withheld"] = null

	if (scope.strength !== ScopeStrength.Soft) {
		const reason = wholeInputReason(tree, scope, evidence.formatCountries)

		if (reason) {
			withheld = { country: scope.country, reason }
			resolver = softStandIn()
		}
	}

	// Without scope retrieval a soft scope only ranks, so evidence against its country is left to the ranking.
	const ranksOnly = resolver?.strength === ScopeStrength.Soft && !evidence.scopeCountryRetrieval

	if (resolver && !ranksOnly && evidenceContradicts(tree, resolver, evidence.formatCountries)) {
		withheld ??= { country: scope.country, reason: ScopeWithheldReason.ContradictingEvidence }
		resolver = evidence.scopeCountryRetrieval ? softScopeFromLocaleHead(tree, resolver) : null
	}

	if (
		resolver &&
		resolver.strength !== ScopeStrength.Soft &&
		!localeHeadConfirms(tree, resolver) &&
		(await largerNamesakeAbroad(tree, resolver, evidence))
	) {
		withheld = { country: scope.country, reason: ScopeWithheldReason.LargerNamesakeAbroad }
		resolver = softStandIn()
	}

	return { resolver, withheld }
}

/**
 * Whether a geocode that found zero coordinates under `decision` runs again without the scope.
 *
 * It does when the resolver filtered by a locale-inferred country and the locale
 * head didn't read the address as that country's.
 * The address then has zero match inside the country and shows no evidence of belonging to it.
 */
export function inferredScopeYieldsOnMiss(tree: AddressTree, decision: CountryScopeDecision): boolean {
	const { resolver } = decision

	return (
		resolver?.source === "inferred" && resolver.strength !== ScopeStrength.Soft && !localeHeadConfirms(tree, resolver)
	)
}
