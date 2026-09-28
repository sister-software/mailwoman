/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The countries that print no sub-locality line. Everywhere else the layout carries one.
 *
 *   `%D` appears in 14 of the 197 shipped libaddressinput `fmt` strings. Transcribing the dataset alone would drop
 *   the line for 183 countries (197 minus 14). The replaced formatter surfaced it for 202 of 213 countries.
 *   It emitted the line natively when a template had the slot. It inserted the line above locality otherwise.
 *   `dependent_locality` is a tag
 *   the model is trained to emit, so losing the line loses a labeled span rather than tidying a layout.
 *
 *   Measure the list across the whole path rather than reading the templates alone.
 *   Template inspection can mislead in two ways. The United States names `suburb` as the fourth alternative
 *   in an alternation whose first alternative is the city. The city is always populated, so the source contains
 *   a sub-locality slot that never renders. Germany names no sub-locality slot, yet the old formatter printed one.
 *   It inserted a line after rendering for that case. Render each country below through the old engine with a
 *   `suburb` value and an otherwise full dictionary. Include a country only when the value disappears even though
 *   its template has the slot. That is the combination the splice did not cover.
 *
 *   The line goes directly above the locality. Every template with a sub-locality line uses that position.
 *
 *   Refreshing IT takes deliberate work. The source is no longer a dependency of this repository.
 *   Postal operators' addressing guides provide a better source. Reviewing those guides one country at a time
 *   takes more work than rerunning this census.
 */

/**
 * ISO 3166-1 alpha-2 codes whose layout carries no `dependent_locality` line.
 */
export const NO_SUB_LOCALITY_LINE_COUNTRIES: ReadonlySet<string> = new Set([
	"BJ",
	"CA",
	"CD",
	"CG",
	"FM",
	"MH",
	"MR",
	"MT",
	"TG",
	"US",
	"YE",
])
