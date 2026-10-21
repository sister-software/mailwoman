/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Written forms of a country's postcode that libaddressinput's `zip` pattern omits.
 *
 *   `./data.ts` is generated from libaddressinput and states the form a postal form prints. People also write
 *   forms that pattern refuses, and a refused correct code makes shape coherence exclude it. Each entry here is
 *   one such form, observed in written address text, as an unanchored pattern in the regex subset JavaScript and
 *   Python share. `postcodeSyntax` accepts a value that matches the libaddressinput pattern or any entry.
 *
 *   The table states syntax only. An entry records a way of writing the country's code, and dictionary
 *   membership stays with the postcode dictionary readers.
 */

/**
 * Additional written postcode forms keyed by ISO 3166-1 alpha-2.
 */
export const COUNTRY_POSTCODE_WRITTEN_FORMS: Readonly<Record<string, readonly string[]>> = {
	/**
	 * ZIP+4 written with no separator, as in `057014673`.
	 *
	 * Golden dev v0.1.3 writes 69 of its 194 US ZIP+4 codes this way, and the v0.7.10 heldout sample 16 of 16.
	 * In those sets and the gauntlet board, every other country whose pattern has a separator writes it.
	 */
	US: ["\\d{5}\\d{4}"],
}
