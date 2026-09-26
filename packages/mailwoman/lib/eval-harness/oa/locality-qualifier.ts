/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The trailing parenthetical an OpenAddresses locality sometimes carries, and the one function that removes it.
 *
 *   `Manilla (Rural)` is the town of Manilla reached on a rural route; the parenthesis is the source's delivery-type
 *   marker rather than part of the place name, so grading against the raw expectation marks the parser's correct
 *   `Manilla` answer wrong.
 *
 *   A gazetteer name may carry one too, so this is a fallback rather than an up-front normalization: a caller compares
 *   the raw surfaces first and reaches for the stripped form only when that misses, which can add credit only where the
 *   base name already matches. The strip applies to the expectation, never to what a run answered.
 *
 *   Two readers need it and they have to agree, so it is a function rather than a regex typed into each: the panel
 *   reader keys rows by locality, and the resolver eval compares an expectation to a resolved name.
 */

/**
 * A trailing qualifier in parentheses at the end of a name, anchored so a parenthesis
 * anywhere else is left alone — the convention removed is a suffix.
 */
const TRAILING_PARENTHETICAL = /\s*\([^)]*\)\s*$/

/**
 * `name` with a trailing parenthetical qualifier removed, or `name` unchanged when it carries none.
 *
 * A name that is only a parenthetical comes back unchanged rather than emptied,
 * because an empty locality is a row the caller drops silently.
 */
export function stripParentheticalQualifier(name: string): string {
	const stripped = name.replace(TRAILING_PARENTHETICAL, "").trim()

	return stripped || name
}

/**
 * Whether {@linkcode stripParentheticalQualifier} would change `name`, so a caller can
 * count what it changed without comparing strings at the call site.
 */
export function hasParentheticalQualifier(name: string): boolean {
	return stripParentheticalQualifier(name) !== name
}
