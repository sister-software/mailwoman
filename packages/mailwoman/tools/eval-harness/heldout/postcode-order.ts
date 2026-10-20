/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Scores the held-out non-native postcode-order sweep, the golden `{raw, components, country}` rows
 *   `non-native-postcode-order-eval.run.ts` writes from a corpus `test` split.
 *
 *   Each `raw` is parsed on the geocode path (`parseForGeocode`, which builds its options with
 *   `geocodeParseInputs`) under the geocode session's default priors, rather than with a bare
 *   `classifier.parse`. The prediction is folded into the golden vocabulary and compared with the
 *   per-locale check's own fold and exact-match, so a row scores the same here as it would there.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import { parseForGeocode } from "#geocode/core"
import { loadParsePriors } from "#geocode/parse-priors"
import { GEOCODE_SESSION_DEFAULTS } from "#geocode/session"
import { exactMatch, foldToComponents } from "#tools/eval-harness/per/locale-f1"
import { normalizeComponent } from "#tools/eval-harness/per/tag-f1"

/**
 * One golden row, as the sweep writes it.
 */
export interface PostcodeOrderGoldenRow {
	raw: string
	components: Record<string, string>
	country: string
}

/**
 * A count of matching rows over the rows that could match.
 */
export interface MatchRate {
	matched: number
	/**
	 * Rows whose golden components hold the compared span (every row, for the full-component match).
	 */
	of: number
	rate: number
}

/**
 * The three exact-match rates of one country or of the whole file.
 */
export interface PostcodeOrderScore {
	rows: number
	postcode: MatchRate
	locality: MatchRate
	/**
	 * Every tag in the prediction or the golden row matches.
	 */
	full: MatchRate
}

/**
 * Per-country and overall scores, countries sorted by code.
 */
export interface PostcodeOrderReport {
	overall: PostcodeOrderScore
	byCountry: Record<string, PostcodeOrderScore>
}

function emptyScore(): PostcodeOrderScore {
	return {
		rows: 0,
		postcode: { matched: 0, of: 0, rate: 0 },
		locality: { matched: 0, of: 0, rate: 0 },
		full: { matched: 0, of: 0, rate: 0 },
	}
}

function tally(rate: MatchRate, applies: boolean, matched: boolean): void {
	if (!applies) return

	rate.of++

	if (matched) {
		rate.matched++
	}
}

function finish(score: PostcodeOrderScore): PostcodeOrderScore {
	for (const rate of [score.postcode, score.locality, score.full]) {
		rate.rate = rate.of ? rate.matched / rate.of : 0
	}

	return score
}

/**
 * Scores folded predictions against their golden rows, index by index.
 *
 * A span counts only on rows whose golden components hold it, so each denominator states the rows it covers.
 */
export function scoreNonNativeOrderRows(
	rows: readonly PostcodeOrderGoldenRow[],
	predictions: ReadonlyArray<Record<string, string>>
): PostcodeOrderReport {
	if (rows.length !== predictions.length) {
		throw new Error(`${rows.length} golden rows but ${predictions.length} predictions`)
	}

	const overall = emptyScore()
	const byCountry = new Map<string, PostcodeOrderScore>()

	for (const [index, row] of rows.entries()) {
		const prediction = predictions[index]!
		const country = row.country.toUpperCase()
		const score = byCountry.get(country) ?? emptyScore()

		byCountry.set(country, score)

		for (const target of [overall, score]) {
			target.rows++

			for (const tag of ["postcode", "locality"] as const) {
				const gold = normalizeComponent(row.components[tag])

				tally(target[tag], gold.length > 0, gold === normalizeComponent(prediction[tag]))
			}

			tally(target.full, true, exactMatch(prediction, row.components))
		}
	}

	return {
		overall: finish(overall),
		byCountry: Object.fromEntries(
			[...byCountry.keys()].toSorted().map((country) => [country, finish(byCountry.get(country)!)])
		),
	}
}

/**
 * Options for {@linkcode parsePostcodeOrderRows}.
 */
export interface ParsePostcodeOrderOptions {
	/**
	 * A package-shaped weights directory, such as a `stage-candidate-cache` root.
	 * It loads as production loads it.
	 *
	 * Absent, the shipped weights resolve as production resolves them.
	 */
	weightsCache?: string
	reportError?: (line: string) => void
}

/**
 * Parses every row on the geocode path and returns the folded predictions, in row order.
 */
export async function parsePostcodeOrderRows(
	rows: readonly PostcodeOrderGoldenRow[],
	options: ParsePostcodeOrderOptions = {}
): Promise<{ predictions: Array<Record<string, string>>; modelPath: string | null }> {
	const reportError = options.reportError ?? console.error

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: "en-US",
		...(options.weightsCache ? { cacheRoot: options.weightsCache } : {}),
	})

	const priors = await loadParsePriors(classifier, {
		gazetteerPrior: GEOCODE_SESSION_DEFAULTS.gazetteerPrior,
		venueHeadPrior: GEOCODE_SESSION_DEFAULTS.venueHeadPrior,
		label: "the graded classifier",
		onWarn: (message) => reportError(`[priors] ${message}`),
	})

	const predictions: Array<Record<string, string>> = []

	for (const row of rows) {
		const venueHead = priors.venueHeadFor(row.country)

		const tree = await parseForGeocode(row.raw, {
			classifier,
			streetMorphologyPrior: GEOCODE_SESSION_DEFAULTS.streetMorphologyPrior,
			...(priors.fst ? { fst: priors.fst } : {}),
			...(priors.streetMorphology ? { streetMorphology: priors.streetMorphology } : {}),
			...(priors.anchorRegions ? { anchorRegions: priors.anchorRegions } : {}),
			...(venueHead ? { venueHead } : {}),
			venueHeadOpts: priors.venueHeadOptsFor(row.country),
		})

		predictions.push(foldToComponents(decodeAsJSON(tree)))
	}

	return { predictions, modelPath: classifier.resolvedWeights?.modelPath ?? null }
}
