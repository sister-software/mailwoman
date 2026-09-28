/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Casing policy that is ours rather than the language's.
 *   The primitives (`titleCase`, `isUpperCase`, `isLowerCase`, `matchCase`, `sentenceCase`)
 *   live in `spliterator`.
 *   This module fixes the thresholds and short-token rules an address parser needs on top of
 *   them.
 */

import { isLowerCase, isUpperCase, titleCase } from "spliterator/casing"

/**
 * Cased letters an input needs before it counts as uniformly cased rather than
 * shouting punctuation or a stray token.
 *
 * A digit- or punctuation-only input is then not treated as a whole shouting address.
 */
const MIN_CASED_LETTERS = 3

/**
 * Runs of this many Latin letters or fewer are abbreviations in address text.
 *
 * State codes NY/DC, directionals N/NW/SE, suffixes ST/RD and the NL postcode
 * suffix LG all read best uppercase.
 * Titlecasing `NY` to `Ny` lands a region as a locality.
 */
const ABBREVIATION_LENGTH = 2

/**
 * Uppercases the first character of a phrase and leaves the rest as typed.
 */
export function upperFirst(phrase: string): string {
	return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/**
 * True when `text` is Latin-script all-caps, at least three uppercase letters
 * without a lowercase or other-script cased letter.
 *
 * Diacritics are admitted, so `RUE DU FAUBOURG SAINT-HONORÉ` qualifies, while an accented
 * uppercase input otherwise reaches the model as single-character pieces.
 * A cased letter from another script disqualifies the whole input, since its case
 * rules are locale-sensitive and can change length.
 */
export function isAllCapsInput(text: string): boolean {
	return isUpperCase(text, { minimumCased: MIN_CASED_LETTERS, script: "latin" })
}

/**
 * True when `text` is pure-ASCII all-lowercase, at least three lowercase
 * letters without an uppercase letter.
 *
 * The mirror of {@link isAllCapsInput}.
 * It binds to pure ASCII because a lowercase input with diacritics parses as typed,
 * so the restore has no accented population to serve.
 */
export function isAllLowerInput(text: string): boolean {
	return isLowerCase(text, { minimumCased: MIN_CASED_LETTERS, script: "ascii" })
}

/**
 * Titlecase each Latin run longer than an abbreviation and keep the abbreviations as typed.
 *
 * `palestine` becomes `Palestine` and `honorÉ` becomes `Honoré`.
 * On all-caps input, abbreviations remain uppercase.
 *
 * The model reads them in that form.
 * Length-preserving, so token offsets never move.
 */
export function titleCaseInput(text: string): string {
	return titleCase(text, { shortLength: ABBREVIATION_LENGTH })
}

/**
 * Restore a fully-lowercase input to the mixed case the model was trained on.
 *
 * Each run longer than an abbreviation is titlecased and the abbreviations are
 * uppercased (`dc` → `DC`, `nw` → `NW`).
 * Length-preserving.
 *
 * `1600 pennsylvania ave nw, washington dc` and `1600 pennsylvania AVE NW, washington DC` both
 * canonicalize to `1600 Pennsylvania Ave NW, Washington DC`, the form that parses `region:DC`.
 */
export function restoreLowerInput(text: string): string {
	return titleCase(text, { shortLength: ABBREVIATION_LENGTH, short: "upper" })
}

/**
 * Normalize a shouting or whispering input to canonical mixed case before the model.
 *
 * Mixed-case and accented or non-Latin input pass through byte-identically.
 * All-caps registry and compliance data (`214 JONES RD, ELKHART, TX 75839`) is
 * partly out-of-domain for a model trained on mixed-case text.
 * It causes dropped or mis-bounded tokens.
 *
 * Titlecasing first recovers it.
 * Fully-lowercase input is as out-of-domain, since it fragments the street and drops the state code.
 *
 * Detection is deliberately strict, so mixed-case input is never touched.
 */
export function normalizeInputCase(text: string): string {
	if (isAllCapsInput(text)) return titleCaseInput(text)

	if (isAllLowerInput(text)) return restoreLowerInput(text)

	return text
}
