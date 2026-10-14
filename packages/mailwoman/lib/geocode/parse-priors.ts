/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The decode-time priors a production parse feeds the classifier: the gazetteer FST that ships
 *   beside the weights, the street-morphology matcher, and the venue-head lexicon of the input's
 *   country. The geocode session, the runtime pipeline, the gauntlet harness and the promotion
 *   battery load them through this module, so a switch graded on one path is the switch the other
 *   paths run.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import {
	type ClassifierOpts,
	type FSTMatcherLike,
	streetContextRequirementFor,
	type VenueHeadLexiconLike,
	type VenueHeadPriorOpts,
} from "@mailwoman/core/pipeline"
import { venueHeadLexicon } from "@mailwoman/poi-taxonomy/venue-heads"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { loadStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street"
import type { PathBuilderLike } from "path-ts"

/**
 * The artifact paths a loaded classifier exposes for its priors.
 *
 * A classifier loaded from a weights package exposes both.
 * A classifier built from a bare ONNX path exposes neither, and the loader then returns no matcher.
 */
export interface ParsePriorArtifacts {
	/**
	 * The per-locale gazetteer FST, such as `fst-en-us.bin`.
	 */
	fstPath?: PathBuilderLike | null | undefined
	/**
	 * The sealed street-morphology FST.
	 *
	 * Absent, the loader builds the matcher from the bundled dictionaries.
	 */
	streetMorphologyPath?: string | null | undefined
}

/**
 * Options for {@link loadParsePriors}.
 */
export interface LoadParsePriorsOptions {
	/**
	 * Whether to load the gazetteer FST, and with it the street-morphology matcher.
	 *
	 * @defaultValue `true`
	 */
	gazetteerPrior?: boolean
	/**
	 * A gazetteer FST the caller already holds, used in place of the artifact at `fstPath`.
	 *
	 * The street-morphology matcher then loads beside it.
	 */
	fst?: FSTMatcherLike | null
	/**
	 * Whether {@link ParsePriors.venueHeadFor} returns a lexicon.
	 *
	 * @defaultValue `true`
	 */
	venueHeadPrior?: boolean
	/**
	 * A name for the classifier in warnings, such as its locale.
	 */
	label?: string
	/**
	 * Receives one message for each requested prior that could not be loaded.
	 *
	 * @defaultValue `console.warn`
	 */
	onWarn?: (message: string) => void
}

/**
 * The loaded priors of one classifier.
 */
export interface ParsePriors {
	/**
	 * The gazetteer FST, or `null` when it was not requested or its artifact did not load.
	 */
	fst: FSTMatcherLike | null
	/**
	 * The street-morphology matcher, or `null` when the FST is absent or the matcher did not load.
	 *
	 * The street-context check needs both matchers, so the matcher is loaded only beside an FST.
	 */
	streetMorphology: FSTMatcherLike | null
	/**
	 * The venue-head lexicon for a country, or `null` when the venue-head prior was not requested.
	 *
	 * A `null` country reads the language aggregates and no country table.
	 */
	venueHeadFor(country: string | null): VenueHeadLexiconLike | null
}

/**
 * Loads the priors a production parse feeds the classifier.
 *
 * A requested prior whose artifact is absent or unreadable is reported through `onWarn`
 * and returned as `null`, because a parse without it is the base model's parse rather than the prior's.
 */
export async function loadParsePriors(
	artifacts: ParsePriorArtifacts,
	options: LoadParsePriorsOptions = {}
): Promise<ParsePriors> {
	const warn = options.onWarn ?? ((message: string) => console.warn(`[mailwoman] ${message}`))
	const label = options.label ?? "the classifier"

	let fst: FSTMatcherLike | null = options.fst ?? null
	let streetMorphology: FSTMatcherLike | null = null

	if (options.gazetteerPrior ?? true) {
		if (!fst && artifacts.fstPath) {
			try {
				fst = deserializeFST(await readLocalBuffer(artifacts.fstPath))
			} catch (error) {
				warn(`failed to load the gazetteer FST at ${artifacts.fstPath}: ${(error as Error).message}`)
			}
		}

		if (!fst) {
			warn(
				`the gazetteer prior was requested for ${label} but no FST artifact resolved` +
					`${artifacts.fstPath ? ` at ${artifacts.fstPath}` : " (the weights package ships none)"} — the gazetteer ` +
					"channel is off for this classifier. Results are the base model's, not the prior's."
			)
		}

		if (fst) {
			try {
				streetMorphology = (
					await loadStreetMorphologyFST({
						...(artifacts.streetMorphologyPath ? { artifactPath: artifacts.streetMorphologyPath } : {}),
						onWarn: warn,
					})
				).matcher
			} catch (error) {
				warn(`street-morphology FST unavailable: ${(error as Error).message} — check off`)
			}
		}
	}

	const venueHeadPrior = options.venueHeadPrior ?? true
	const lexicons = new Map<string, VenueHeadLexiconLike>()

	return {
		fst,
		streetMorphology,
		venueHeadFor: (country) => {
			if (!venueHeadPrior) return null

			const key = (country ?? "").toUpperCase()
			let lexicon = lexicons.get(key)

			if (!lexicon) {
				lexicon = venueHeadLexicon(key)
				lexicons.set(key, lexicon)
			}

			return lexicon
		},
	}
}

/**
 * The switches that select which loaded priors a parse applies.
 */
export interface ParsePriorSelection {
	/**
	 * Whether the street-morphology matcher biases a street affix on a numbered segment.
	 *
	 * Without it the matcher serves the street-context check at zero emission weight.
	 */
	streetMorphologyPrior?: boolean
	/**
	 * The venue-head lexicon to apply, or `null` for none.
	 */
	venueHead?: VenueHeadLexiconLike | null
	/**
	 * Overrides for the venue-head prior, applied only with a lexicon.
	 */
	venueHeadOpts?: VenueHeadPriorOpts
}

/**
 * The classifier options that pass the loaded priors to one parse.
 */
export type ParsePriorOptions = Partial<
	Pick<
		ClassifierOpts,
		| "fst"
		| "fstStreetMorphology"
		| "fstStreetMorphologyOpts"
		| "fstStreetContextPositiveScale"
		| "venueHead"
		| "venueHeadOpts"
	>
>

/**
 * Returns the classifier options that feed the loaded priors to a parse.
 *
 * The FST and the street-context options come from the core helper the runtime pipeline uses,
 * so every path passes the same weights for the same switch.
 */
export function parsePriorOptions(
	priors: Pick<ParsePriors, "fst" | "streetMorphology">,
	selection: ParsePriorSelection = {}
): ParsePriorOptions {
	return {
		...(priors.fst ? { fst: priors.fst } : {}),
		...streetContextRequirementFor(
			{ fst: priors.fst, streetMorphology: priors.streetMorphology },
			{ streetMorphologyPrior: selection.streetMorphologyPrior ?? false }
		),
		...(selection.venueHead ? { venueHead: selection.venueHead } : {}),
		...(selection.venueHead && selection.venueHeadOpts ? { venueHeadOpts: selection.venueHeadOpts } : {}),
	}
}
