/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type {
	LocaleHint,
	NormalizedInputLite,
	PipelineOpts,
	PipelineResult,
	POIIntent,
	POIIntentOutcome,
} from "@mailwoman/core/pipeline"
import { matchPOISubject, type POIPhraseLookup, type POIPhraseMatch } from "@mailwoman/kind-classifier"
import {
	lookupPOIBrand,
	lookupPOICategory,
	lookupPOICategoryLocaleNormalized,
	lookupPOICategoryTypo,
	resolveBrandName,
} from "@mailwoman/poi-taxonomy"
import type { AliasLookupResult, BrandAlias } from "@mailwoman/variant-aliases"
import { lookupVariantAliases } from "@mailwoman/variant-aliases"

import { resolvePOIAnchorCountry } from "#poi/executor"

interface POINameSearch {
	search(query: { name: string; limit?: number }): ReadonlyArray<{ name: string | null; confidence: number }>
}

/**
 * Adapts a POI full-text reader into a phrase lookup that reports a POI name
 * only on a normalized exact match.
 *
 * FTS only supplies candidates, so a fuzzy or token-overlap hit can never reroute an address.
 */
export function createPOINameLookup(searcher: POINameSearch): POIPhraseLookup {
	return (phrase) => {
		const expected = phrase.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLocaleLowerCase()

		if (!expected) return []

		const hit = searcher.search({ name: phrase, limit: 8 }).find((candidate) => {
			if (!candidate.name) return false

			return candidate.name.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLocaleLowerCase() === expected
		})

		return hit?.name ? [{ kind: "name", categoryID: hit.name, matchedPhrase: hit.name, confidence: 1 }] : []
	}
}

/**
 * Looks a phrase up as a POI category (exact, then locale-normalized, then typo-tolerant),
 * then as a brand, then as a locale-restricted brand alias such as "mcdo".
 *
 * A phrase that matches both a category and a brand always resolves as the category.
 */
export const poiTaxonomyLookup: POIPhraseLookup = (phrase, locale) => {
	let categoryHits = lookupPOICategory(phrase, locale)

	if (!categoryHits.length && (!locale || locale.toLowerCase().startsWith("en"))) {
		const words = phrase.trim().split(/\s+/)
		const tail = words.at(-1)

		if (tail) {
			let singular: string | undefined

			if (/[^aeiou]ies$/i.test(tail)) {
				singular = tail.slice(0, -3) + "y"
			} else if (/(?:ches|shes|xes|zes)$/i.test(tail)) {
				singular = tail.slice(0, -2)
			} else if (/s$/i.test(tail) && !/ss$/i.test(tail)) {
				singular = tail.slice(0, -1)
			}

			if (singular) {
				words[words.length - 1] = singular
				categoryHits = lookupPOICategory(words.join(" "), locale)
			}
		}
	}

	if (categoryHits.length) {
		return categoryHits.map((m) => ({
			kind: "category",
			categoryID: m.category.id,
			matchedPhrase: m.matchedPhrase,
			confidence: m.confidence,
		}))
	}

	const localeNormalizedHits = lookupPOICategoryLocaleNormalized(phrase, locale)

	if (localeNormalizedHits.length) {
		return localeNormalizedHits.map((m) => ({
			kind: "category",
			categoryID: m.category.id,
			matchedPhrase: m.matchedPhrase,
			confidence: m.confidence,
			mechanism: "locale_normalized",
			inputPhrase: phrase,
		}))
	}

	const typoHits = lookupPOICategoryTypo(phrase, locale)

	if (typoHits.length) {
		return typoHits.map((m) => ({
			kind: "category",
			categoryID: m.category.id,
			matchedPhrase: m.matchedPhrase,
			confidence: m.confidence,
			mechanism: "typo",
			inputPhrase: phrase,
		}))
	}

	const brandHits = lookupPOIBrand(phrase)

	if (brandHits.length) {
		return brandHits.map((m): POIPhraseMatch => ({
			kind: "brand",
			categoryID: m.brand.name,
			wikidata: m.brand.wikidata,
			matchedPhrase: m.matchedPhrase,
			confidence: m.confidence,
		}))
	}

	if (!locale) return []

	const isBrandAlias = (hit: AliasLookupResult): hit is AliasLookupResult & { alias: BrandAlias } =>
		hit.alias.kind === "brand"

	const aliasHits = lookupVariantAliases(phrase, locale).filter(isBrandAlias)

	return aliasHits.map(({ alias, confidence }): POIPhraseMatch => {
		const brand = resolveBrandName(alias.brand)

		return {
			kind: "brand",
			categoryID: alias.brand,
			wikidata: brand?.wikidata,
			matchedPhrase: alias.variant,
			confidence,
		}
	})
}

/**
 * Supplies {@link createPOIIntentStage} with its phrase lookup, the parser for the anchor
 * remainder, and an optional executor that turns an intent into an outcome.
 */
export interface POIIntentStageDeps {
	lookup: POIPhraseLookup

	/**
	 * Parses the anchor remainder, such as "Springfield IL", through the address pipeline.
	 *
	 * The pipeline must not include the POI stage, or parsing recurses;
	 * `createRuntimePipeline` supplies one without it.
	 */
	parseAnchor: (text: string, opts?: PipelineOpts) => Promise<PipelineResult>

	/**
	 * The executor, usually from `createPOIExecutor`, that turns a matched intent
	 * into results or an abstention.
	 *
	 * Without it, the stage returns the intent unexecuted.
	 */
	execute?: (intent: POIIntent) => POIIntentOutcome
}

/**
 * Build the `stages.poiIntent` implementation.
 */
export function createPOIIntentStage(
	deps: POIIntentStageDeps
): (input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIIntentOutcome | null> {
	return async (input, locale, opts) => {
		const matched = matchPOISubject(input.normalized, locale.locale, deps.lookup)

		if (!matched) return null

		const intent: POIIntent = {
			subject:
				matched.match.kind === "name"
					? { kind: "name", text: matched.match.categoryID }
					: (matched.match.kind ?? "category") === "brand"
						? {
								kind: "brand",
								name: matched.match.categoryID,
								wikidata: matched.match.wikidata,
								matched: matched.match.matchedPhrase,
							}
						: {
								kind: "category",

								categoryIDs: [...new Set(matched.matches.map((hit) => hit.categoryID))],
								matched: matched.match.matchedPhrase,
							},
		}

		if (matched.relation) {
			intent.relation = matched.relation
		}

		if (matched.remainder) {
			const anchor = await deps.parseAnchor(matched.remainder, opts)
			intent.anchor = { text: matched.remainder, tree: anchor.tree }
		}

		if (intent.subject.kind === "category") {
			const binding = bindCountryScope(matched.matches, resolvePOIAnchorCountry(intent))

			if (binding) {
				intent.subject.countryBinding = {
					anchorCountry: binding.anchorCountry,
					excludedCategoryIDs: binding.excludedCategoryIDs,
				}

				if (!binding.categoryIDs.length) {
					return { type: "abstain", reason: "country_scope_excluded" }
				}

				intent.subject.categoryIDs = binding.categoryIDs
			}
		}

		return deps.execute ? deps.execute(intent) : { type: "intent", intent }
	}
}

/**
 * Splits the categories a phrase reached into those whose hits hold in the anchor's country
 * and those excluded, or returns null when no hit is country-scoped.
 *
 * A null anchor country admits no scoped hit, because a curator's scoped claim
 * cannot be checked without knowing the place.
 */
export function bindCountryScope(
	matches: ReadonlyArray<POIPhraseMatch>,
	anchorCountry: string | null
): { anchorCountry: string | null; categoryIDs: string[]; excludedCategoryIDs: string[] } | null {
	if (!matches.some((hit) => hit.countryScope?.length)) return null

	const reached: string[] = []
	const admitted = new Set<string>()

	for (const hit of matches) {
		if (!reached.includes(hit.categoryID)) {
			reached.push(hit.categoryID)
		}

		const scope = hit.countryScope

		if (!scope?.length || (anchorCountry && scope.some((country) => country.toUpperCase() === anchorCountry))) {
			admitted.add(hit.categoryID)
		}
	}

	return {
		anchorCountry,
		categoryIDs: reached.filter((id) => admitted.has(id)),
		excludedCategoryIDs: reached.filter((id) => !admitted.has(id)),
	}
}
