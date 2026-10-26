/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The code-unit channel: per-piece shape features for each digit run or alphanumeric code (#2845).
 */

import { segmentCodeUnits } from "@mailwoman/mtf/code-units"
import { countriesAcceptingPostcode } from "@mailwoman/postcode/country-formats"

import type { InferChannel } from "#ort-feeds"

/**
 * The features each piece of a code unit carries.
 *
 * `corpus-python/src/mailwoman_train/tokenizer/code_units.py` computes the same five
 * for training, and `test/fixtures/code-unit-parity.json` holds the two equal.
 */
export const CODE_UNIT_FEATURE_DIM = 5

/**
 * The unit length at which the length feature reaches 1.0.
 */
export const CODE_UNIT_MAX_LENGTH = 12

/**
 * The accepting-country count at which that feature reaches 1.0.
 *
 * A bare five-digit unit is accepted by dozens of countries, so the count saturates there
 * and the feature still separates a GB or CA shape, accepted by one country, from a shared numeric one.
 */
export const CODE_UNIT_MAX_ACCEPTING = 32

/**
 * The five features of one unit: in a unit, length, letter share, hyphen, and the share
 * of {@linkcode CODE_UNIT_MAX_ACCEPTING} countries whose postcode syntax accepts it.
 */
export function codeUnitFeatures(unit: string): number[] {
	const letters = [...unit].filter((character) => /[A-Za-z]/u.test(character)).length

	return [
		1,
		Math.min(unit.length, CODE_UNIT_MAX_LENGTH) / CODE_UNIT_MAX_LENGTH,
		letters / unit.length,
		unit.includes("-") ? 1 : 0,
		Math.min(countriesAcceptingPostcode(unit).length, CODE_UNIT_MAX_ACCEPTING) / CODE_UNIT_MAX_ACCEPTING,
	]
}

/**
 * Per-piece features and confidences for the pieces at `pieceSpans`, `[start, end)` offsets into `text`.
 *
 * A piece overlapping a unit carries that unit's features with confidence 1.
 * Any other piece carries zeros with confidence 0.
 */
export function codeUnitChannel(text: string, pieceSpans: ReadonlyArray<readonly [number, number]>): InferChannel {
	const units = segmentCodeUnits(text)
	const features: number[][] = []
	const confidence: number[] = []

	for (const [start, end] of pieceSpans) {
		const unit = units.find((candidate) => start < candidate.end && candidate.start < end)

		features.push(unit ? codeUnitFeatures(unit.text) : Array.from({ length: CODE_UNIT_FEATURE_DIM }, () => 0))
		confidence.push(unit ? 1 : 0)
	}

	return { features, confidence }
}
