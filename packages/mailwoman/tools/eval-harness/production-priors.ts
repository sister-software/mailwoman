/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The production parse priors for a battery leg. A leg that parses with the classifier alone
 *   grades a configuration production never runs, so every floored leg loads the gazetteer FST,
 *   the street-morphology matcher and the venue-head lexicon through the loader the geocode
 *   session uses, under the session's default switches.
 */

import {
	type ParsePriorArtifacts,
	type ParsePriorOptions,
	loadParsePriors,
	parsePriorOptions,
} from "#geocode/parse-priors"
import { GEOCODE_SESSION_DEFAULTS } from "#geocode/session"

/**
 * Returns the parse options that feed a row's priors, keyed by the row's country.
 */
export type ProductionPriorOptions = (country: string | null) => ParsePriorOptions

/**
 * Loads the production priors for a classifier and returns the per-country parse options.
 *
 * The switches are the geocode session's defaults, so the battery grades the parse the session runs.
 * A classifier without an FST artifact reports the absence through `reportError`
 * and parses with the venue-head prior alone.
 */
export async function productionPriorOptions(
	classifier: ParsePriorArtifacts,
	reportError: (line: string) => void = console.error
): Promise<ProductionPriorOptions> {
	const priors = await loadParsePriors(classifier, {
		gazetteerPrior: GEOCODE_SESSION_DEFAULTS.gazetteerPrior,
		venueHeadPrior: GEOCODE_SESSION_DEFAULTS.venueHeadPrior,
		label: "the graded classifier",
		onWarn: (message) => reportError(`[priors] ${message}`),
	})

	reportError(
		`Priors:     fst ${priors.fst ? "on" : "off"}, street-morphology ${priors.streetMorphology ? "on" : "off"} ` +
			`(prior ${GEOCODE_SESSION_DEFAULTS.streetMorphologyPrior ? "on" : "off"}), ` +
			`venue-head ${GEOCODE_SESSION_DEFAULTS.venueHeadPrior ? "on" : "off"}`
	)

	return (country) =>
		parsePriorOptions(priors, {
			streetMorphologyPrior: GEOCODE_SESSION_DEFAULTS.streetMorphologyPrior,
			venueHead: priors.venueHeadFor(country),
		})
}
