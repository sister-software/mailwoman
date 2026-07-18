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
import { matchPOISubject, type POIPhraseLookup } from "@mailwoman/kind-classifier"
import { lookupPOICategory } from "@mailwoman/poi-taxonomy"

/** Adapter: `@mailwoman/poi-taxonomy`'s CategoryMatch → the classifier's injected lookup shape. */
export const poiTaxonomyLookup: POIPhraseLookup = (phrase, locale) =>
	lookupPOICategory(phrase, locale).map((m) => ({
		categoryID: m.category.id,
		matchedPhrase: m.matchedPhrase,
		confidence: m.confidence,
	}))

export interface POIIntentStageDeps {
	lookup: POIPhraseLookup
	/**
	 * Parses the anchor remainder ("Springfield IL") through the ADDRESS pipeline. Callers must hand in a pipeline
	 * WITHOUT the poi stage (recursion guard) — `createRuntimePipeline` does.
	 */
	parseAnchor: (text: string, opts?: PipelineOpts) => Promise<PipelineResult>
}

/** Build the `stages.poiIntent` implementation. */
export function createPOIIntentStage(
	deps: POIIntentStageDeps
): (input: NormalizedInputLite, locale: LocaleHint, opts?: PipelineOpts) => Promise<POIIntentOutcome | null> {
	return async (input, locale, opts) => {
		const matched = matchPOISubject(input.normalized, locale.locale, deps.lookup)

		if (!matched) return null

		const intent: POIIntent = {
			subject: {
				kind: "category",
				categoryID: matched.match.categoryID,
				matched: matched.match.matchedPhrase,
			},
		}

		if (matched.remainder) {
			const anchor = await deps.parseAnchor(matched.remainder, opts)
			intent.anchor = { text: matched.remainder, tree: anchor.tree }
		}

		return { type: "intent", intent }
	}
}
