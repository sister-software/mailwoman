/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The trailing parenthetical an OpenAddresses locality sometimes carries, and the one function that removes it.
 *
 *   `Manilla (Rural)` is the town of Manilla reached on a rural route, and `Denison (rural)` the same. The parenthesis
 *   is the source's delivery-type marker rather than part of the place name, so grading against the raw expectation
 *   marks a correct answer wrong: the parser answers `Manilla`, which is the place. Four of 10,000 expected localities
 *   in `data/eval/external/openaddresses-us-sample.jsonl` carry one — `Rural` twice, `rural` and `town` once each.
 *
 *   A GAZETTEER NAME MAY CARRY ONE TOO, which is why this is a fallback rather than a normalization applied up front:
 *   15,886 of the admin gazetteer's 19,048,147 `names` rows end in a parenthetical, 2,077 of them US, and 1,925 of
 *   those are GNIS's `(historical)` marker for a former place. So a caller compares the raw surfaces first and reaches
 *   for the stripped form only when that misses, which can add credit only where the base name already matches.
 *
 *   The strip applies to the EXPECTATION, never to what a run answered — the same discipline as the alias and ancestry
 *   allowances in `./resolver/admin-match.ts`.
 *
 *   Two readers need it and they have to agree, so it is a function rather than a regex typed into each: the panel
 *   reader (`dev-tools/coord-panel.ts`) keys rows by locality, and the resolver eval compares an expectation to a
 *   resolved name. A copy in one and not the other grades a row by which tool read it.
 */

/**
 * A trailing qualifier in parentheses at the end of a name.
 *
 * Anchored at the end, so a parenthesis anywhere else is left alone: the convention this removes is a suffix, and a
 * name carrying parentheses mid-string is not it.
 */
const TRAILING_PARENTHETICAL = /\s*\([^)]*\)\s*$/

/**
 * `name` with a trailing parenthetical qualifier removed, or `name` unchanged when it carries none.
 *
 * A name that is nothing but a parenthetical comes back unchanged rather than emptied: an empty locality is a row the
 * caller drops silently, and a surface this function cannot read is one it should hand back intact.
 */
export function stripParentheticalQualifier(name: string): string {
	const stripped = name.replace(TRAILING_PARENTHETICAL, "").trim()

	return stripped || name
}

/**
 * Whether {@linkcode stripParentheticalQualifier} would change `name`.
 *
 * Separate from the strip so a caller can count what it changed without comparing strings at the call site — the panel
 * reader reports that count, because a normalizer whose size nobody can see is one nobody can audit.
 */
export function hasParentheticalQualifier(name: string): boolean {
	return stripParentheticalQualifier(name) !== name
}
