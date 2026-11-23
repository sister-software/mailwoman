// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The country one parse is read as, and the country-owned priors it selects by that country:
 * whether the placetype-pair index applies, and which gazetteer FST the parse reads.
 */

import type { ParseOpts } from "#classifier/options"
import { confidentLocaleCountry } from "#labels/address-system"
import type { PairIndexLike } from "#pair/index/resolver"
import type { PlacetypePairPriorOpts } from "#placetype/pair-prior"
import type { FSTMatcherLike } from "#prior/fst"

/**
 * The country a parse's tree resolves containment for: the caller's stated country,
 * or the locale classifier's confident country when the caller states none.
 */
export function containmentCountry(
	localeCountry: { country: string; confidence: number } | null,
	declaredCountry: string | null | undefined
): string | null {
	return declaredCountry?.trim().toUpperCase() || localeCountry?.country || null
}

/**
 * Whether a parse takes the placetype-pair index: always without `pairIndexOwnCountry`,
 * and with it only when the parse's {@linkcode containmentCountry} is the index's country.
 *
 * An index whose header states no country always applies, since it claims no country.
 */
function pairIndexAppliesTo(
	index: Pick<PairIndexLike, "country">,
	opts: Pick<ParseOpts, "pairIndexOwnCountry"> | undefined,
	localeLogits: readonly number[] | null
): boolean {
	const rule = opts?.pairIndexOwnCountry

	if (!rule || !index.country) return true

	const country = containmentCountry(confidentLocaleCountry(localeLogits), rule.declaredCountry)

	return country?.toUpperCase() === index.country.toUpperCase()
}

/**
 * The placetype-pair prior options a parse applies.
 *
 * The parse's `placetypePair` selection picks the options, and
 * {@linkcode pairIndexAppliesTo} admits the index.
 * `"inherit"` (the default) takes `configured`, `"off"` takes none.
 * An options object replaces `configured`.
 */
export function parsePairPrior(
	configured: PlacetypePairPriorOpts | undefined,
	opts: Pick<ParseOpts, "placetypePair" | "pairIndexOwnCountry"> | undefined,
	localeLogits: readonly number[] | null
): PlacetypePairPriorOpts | undefined {
	const selection = opts?.placetypePair ?? "inherit"
	const selected = selection === "inherit" ? configured : selection === "off" ? undefined : selection

	return selected && pairIndexAppliesTo(selected.index, opts, localeLogits) ? selected : undefined
}

/**
 * The gazetteer FST a parse reads: the FST of the country the locale head confidently reads
 * when `fstForCountry` returns one, else `fst`.
 *
 * A head that reads no country confidently, or a country without an FST, keeps `fst`.
 */
export async function fstForParse(
	opts: Pick<ParseOpts, "fst" | "fstForCountry"> | undefined,
	localeLogits: readonly number[] | null
): Promise<FSTMatcherLike | null> {
	const fallback = opts?.fst ?? null

	if (!fallback || !opts?.fstForCountry) return fallback

	const verdict = confidentLocaleCountry(localeLogits)

	if (!verdict) return fallback

	return (await opts.fstForCountry(verdict.country)) ?? fallback
}
