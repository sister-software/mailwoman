/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The words before a US municipality's name that state its legal form, longest first.
 *
 * NAD writes `Inc_Muni` with them (`Town of Madison`, `CITY OF WAUWATOSA`, `Charter Township of Canton`).
 * A letter is addressed to the bare name.
 */
const US_MUNICIPAL_LEGAL_FORMS = [
	"charter township of",
	"township of",
	"borough of",
	"village of",
	"city of",
	"town of",
] as const

/**
 * The municipality's name without its leading legal-form words, or `null` when it has none.
 *
 * The bare form keeps the publisher's case: `CITY OF WAUWATOSA` becomes `WAUWATOSA`.
 */
export function bareMunicipalityName(written: string): string | null {
	const lowered = written.toLowerCase()

	for (const form of US_MUNICIPAL_LEGAL_FORMS) {
		if (lowered.startsWith(`${form} `)) {
			const bare = written.slice(form.length).trim()

			return bare || null
		}
	}

	return null
}
