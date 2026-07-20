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
import { lookupPOIBrand, lookupPOICategory, resolveBrandName } from "@mailwoman/poi-taxonomy"
import type { AliasLookupResult, BrandAlias } from "@mailwoman/variant-aliases"
import { lookupVariantAliases } from "@mailwoman/variant-aliases"

/**
 * The union phrase → subject lookup (part 2 of the brand-lexicon work): `@mailwoman/poi-taxonomy` categories first
 * (existing behavior, unchanged), then the taxonomy's own brand table (`lookupPOIBrand`, exact-phrase, no locale
 * gating), then `@mailwoman/variant-aliases`' brand-kind regional slang (locale-gated, e.g. "mcdo" → fr-FR/fr-CA/fr-BE)
 * chained through `resolveBrandName` to recover the QID.
 *
 * Precedence on a phrase that matches BOTH a category and a brand: CATEGORY WINS. Deterministic, and intentional —
 * `@mailwoman/poi-taxonomy`'s categories are the curated set; a brand phrase collision (none observed in the shipped
 * table as of the 2026-07-20 build) would be a data quality bug in the brand table, not a case to special-case here.
 */
export const poiTaxonomyLookup: POIPhraseLookup = (phrase, locale) => {
	const categoryHits = lookupPOICategory(phrase, locale)

	if (categoryHits.length > 0) {
		return categoryHits.map((m) => ({
			kind: "category",
			categoryID: m.category.id,
			matchedPhrase: m.matchedPhrase,
			confidence: m.confidence,
		}))
	}

	const brandHits = lookupPOIBrand(phrase)

	if (brandHits.length > 0) {
		return brandHits.map(
			(m): POIPhraseMatch => ({
				kind: "brand",
				categoryID: m.brand.name,
				wikidata: m.brand.wikidata,
				matchedPhrase: m.matchedPhrase,
				confidence: m.confidence,
			})
		)
	}

	// Regional brand slang is locale-gated — nothing to chain without a detected/asserted locale.
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
	 * The executor (Task 4, `poi-executor.ts`'s `createPOIExecutor`) — when present, the stage runs the matched intent
	 * through it and returns whatever it decides (results attached, or an abstain). Absent = today's Plan-2 behavior: the
	 * bare `{ type: "intent", intent }`, unexecuted.
	 */
	execute?: (intent: POIIntent) => POIIntentOutcome
}

/** Build the `stages.poiIntent` implementation. */
export function createPOIIntentStage(
	deps: POIIntentStageDeps
): (input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIIntentOutcome | null> {
	return async (input, locale, opts) => {
		const matched = matchPOISubject(input.normalized, locale.locale, deps.lookup)

		if (!matched) return null

		const intent: POIIntent = {
			subject:
				(matched.match.kind ?? "category") === "brand"
					? {
							kind: "brand",
							name: matched.match.categoryID,
							wikidata: matched.match.wikidata,
							matched: matched.match.matchedPhrase,
						}
					: {
							kind: "category",
							categoryID: matched.match.categoryID,
							matched: matched.match.matchedPhrase,
						},
		}

		if (matched.remainder) {
			const anchor = await deps.parseAnchor(matched.remainder, opts)
			intent.anchor = { text: matched.remainder, tree: anchor.tree }
		}

		return deps.execute ? deps.execute(intent) : { type: "intent", intent }
	}
}
