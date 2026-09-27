/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Casing of British place and street names.
 *
 *   Price Paid Data ships every field upper-case.
 *   All-caps is out of domain for a model trained on natural casing (#690).
 */

import { titleCase } from "spliterator/casing"

/**
 * Joining particles that stay lowercase mid-name, between words and between hyphen segments:
 * `Barrow upon Soar`, `Weston-super-Mare`, `Wells next the Sea`.
 * A leading particle is capitalized (`The Green`).
 */
export const GB_PLACE_NAME_PARTICLES: ReadonlySet<string> = new Set([
	"upon",
	"on",
	"under",
	"in",
	"by",
	"the",
	"le",
	"la",
	"de",
	"cum",
	"next",
	"with",
	"over",
	"at",
	"super",
	"sub",
	"and",
	"of",
	"y",
	"en",
])

/**
 * Titlecases an all-caps GB place or street name, keeping {@link GB_PLACE_NAME_PARTICLES}
 * lowercase after the first word.
 *
 * Apostrophe-separated segments are cased on their own (`D'Arcy`, `James'`) except a possessive `'s`.
 * Whitespace is collapsed and trimmed, as the source pads its fields.
 */
export function titleCaseGB(value: string): string {
	return titleCase(value.trim().replaceAll(/\s+/gu, " "), { particles: GB_PLACE_NAME_PARTICLES })
}
