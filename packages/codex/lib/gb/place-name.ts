/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Normalizes casing of British place and street names.
 *   Price Paid Data ships every field in uppercase. Models trained on natural casing see uppercase as out-of-domain text.
 */

import { titleCase } from "spliterator/casing"

/**
 * Lowercase particles stay lowercase between words and hyphen segments (`Barrow upon
 * Soar`, `Weston-super-Mare`), with a leading particle capitalized (`The Green`).
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
 * Titlecase an all-caps GB place or street name, keeping {@link GB_PLACE_NAME_PARTICLES}
 * lowercase after the first word and casing apostrophe segments on their own.
 */
export function titleCaseGB(value: string): string {
	return titleCase(value.trim().replaceAll(/\s+/gu, " "), { particles: GB_PLACE_NAME_PARTICLES })
}
