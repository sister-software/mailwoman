/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POI intent stage assembly (spec §3.1–3.2). This is the ONLY module that joins the pieces:
 *   `@mailwoman/poi-taxonomy` (the lexicon), `@mailwoman/kind-classifier` (subject matching), and
 *   the pipeline contract from core. Wired by `createRuntimePipeline({ poiQueryKind: true })`;
 *   dormant otherwise.
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
 * Adapt a POI FTS reader into positive, exact-name evidence for the kind classifier. FTS supplies candidates; the
 * normalized equality check is the check, so a fuzzy/token-overlap result can never reroute an address.
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
 * The union phrase → subject lookup (part 2 of the brand-lexicon work): `@mailwoman/poi-taxonomy` categories first
 * (existing behavior, unchanged), then the taxonomy's own brand table (`lookupPOIBrand`, exact-phrase, no locale
 * filtering), then `@mailwoman/variant-aliases`' brand-kind regional slang (locale-restricted, e.g. "mcdo" →
 * fr-FR/fr-CA/fr-BE) chained through `resolveBrandName` to recover the QID.
 *
 * Precedence on a phrase that matches BOTH a category and a brand: CATEGORY WINS. Deterministic, and intentional —
 * `@mailwoman/poi-taxonomy`'s categories are the curated set; a brand phrase collision (none observed in the shipped
 * table as of the 2026-07-20 build) would be a data quality bug in the brand table, not a case to special-case here.
 */
export const poiTaxonomyLookup: POIPhraseLookup = (phrase, locale) => {
	let categoryHits = lookupPOICategory(phrase, locale)

	// The taxonomy stays exact-phrase; this adapter supplies a deliberately small English morphology layer for query
	// heads. Positive evidence is still required: the singularized phrase must itself hit the taxonomy.
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

	// Regional brand slang is locale-restricted — nothing to chain without a detected/asserted locale.
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

export interface POIIntentStageDeps {
	lookup: POIPhraseLookup
	/**
	 * Parses the anchor remainder ("Springfield IL") through the ADDRESS pipeline. Callers must hand in a pipeline
	 * WITHOUT the poi stage (recursion guard) — `createRuntimePipeline` does.
	 */
	parseAnchor: (text: string, opts?: PipelineOpts) => Promise<PipelineResult>
	/**
	 * The executor (`poi-executor.ts`'s `createPOIExecutor`) — when present, the stage runs the matched intent through it
	 * and returns whatever it decides (results attached, or an abstain). Absent, the stage yields the bare `{ type:
	 * "intent", intent }`, unexecuted.
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
								// Every category the subject reached, deduplicated and left in the lookup's own enumeration order —
								// the executor searches their union, so a repeated id would probe the same leaves twice.
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

		// The place binding (#1999). A hit's `countryScope` is a claim about establishments, so it is judged against the
		// country the anchor RESOLVED to — which exists only now, after the anchor parse — and never against the caller's
		// locale. Recorded on the intent whether or not it removed anything, so a receipt can say which country the set
		// was bound to and what fell out.
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
 * What the anchor's country does to a reached set: which categories stay searchable and which fall out.
 *
 * A category stays when ANY hit reaching it holds where the anchor is — an unscoped hit holds everywhere, a scoped one
 * holds when its list names the anchor's country. A `null` anchor country admits no scoped hit: a claim the curator
 * scoped to a place cannot be checked without knowing the place, and searching as though it held would answer with a
 * category the data there may not carry. Order is the lookup's own enumeration, and it still states no preference.
 *
 * `null` when no hit carries a scope at all — there was nothing to bind, and a receipt should not record a binding that
 * decided nothing.
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
