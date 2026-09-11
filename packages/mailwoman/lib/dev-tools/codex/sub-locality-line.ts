/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The countries that print NO sub-locality line. Everywhere else the layout carries one.
 *
 *   `%D` appears in 14 of the 197 shipped libaddressinput `fmt` strings, so transcribing the dataset alone would drop
 *   the line for 183 countries. The formatter this table replaces surfaced it for 202 of its 213 — natively where a
 *   template had the slot, and by splicing a line in above the locality where none did. `dependent_locality` is a tag
 *   the model is trained to emit, so losing the line loses a labeled span rather than tidying a layout.
 *
 *   THE LIST IS MEASURED, NOT READ, and the measurement has to cover the whole path rather than the templates. Reading
 *   a template is unreliable twice over: the United States names `suburb` as the fourth alternative of an alternation
 *   whose first alternative is the city, which is always populated, so the slot is present in the source and never
 *   renders — while Germany names no sub-locality slot at all and still printed one, because the old formatter spliced
 *   a line in after the render for exactly that case. Each country below was rendered through the old engine with a
 *   `suburb` value against an otherwise full dict, and appears here only when the value did NOT come back AND the
 *   template named the slot, which is the one combination the splice did not cover.
 *
 *   The line goes directly above the locality, which is where every template that has one puts it.
 *
 *   REFRESHING IT is deliberate work: the source is no longer a dependency of this repository. The better source is
 *   each postal operator's own addressing guide, one country at a time, which is a larger task than a re-run.
 */

/**
 * ISO 3166-1 alpha-2 codes whose layout carries NO `dependent_locality` line.
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
