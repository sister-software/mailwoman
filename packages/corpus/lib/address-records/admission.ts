/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which OpenAddresses source runs the address layer admits, by the license each run's definition records.
 */

/**
 * The stated terms that admit a source: no restriction, or an open grant.
 */
const OPEN_TERMS = /public domain|no restrictions|^cc[ -]?0|^cc[ -]by/iu

/**
 * A restricting license element in any spelling, such as `CC BY-NC 4.0`, `CC BY SA` or `NoDerivatives`.
 *
 * It is tested before {@link OPEN_TERMS}, so a `CC BY` grant that adds one of these is refused.
 */
const RESTRICTING_TERMS = /\b(?:nc|nd|sa)\b|non-?commercial|no-?deriv|share-?alike/iu

/**
 * Open license pages an OpenAddresses definition can link to in place of stating the terms.
 */
const OPEN_LICENSE_URL = /creativecommons\.org\/(?:publicdomain|licenses\/by\/)/iu

/**
 * Decides whether a source definition's recorded license admits its rows.
 *
 * Under the repository's US position, a public body's file published without restricting
 * terms is elected, so a definition that records no terms is admitted.
 * A definition that records terms is admitted only when those terms are an open grant.
 *
 * Share-alike, restricting text and a terms page this reader has not read are refused.
 */
export function isAdmittedLicense(license: unknown): boolean {
	if (license == null) return true

	if (typeof license === "string") {
		return !RESTRICTING_TERMS.test(license) && (OPEN_TERMS.test(license) || OPEN_LICENSE_URL.test(license))
	}

	const { text, url, "share-alike": shareAlike } = license as { text?: string; url?: string; "share-alike"?: boolean }

	if (shareAlike) return false

	if (text) return !RESTRICTING_TERMS.test(text) && OPEN_TERMS.test(text)

	if (url) return OPEN_LICENSE_URL.test(url)

	return true
}

/**
 * Sources whose recorded terms a reader checked and found to restrict no use,
 * with the wording that decided each.
 *
 * `isAdmittedLicense` reads a pattern over the wording and refuses each of them.
 */
const REVIEWED_OPEN: Readonly<Record<string, string>> = {
	"us/tx/san_antonio":
		"data.sanantonio.gov carries a CC BY 4.0 notice, and the recorded `Indemnification` restricts no use.",
	"us/ca/city_of_san_diego": "The recorded terms are the ODC PDDL, a public domain dedication.",
	"us/pa/somerset": "The recorded terms read `Access_Constraints: None. Use_Constraints: None.`",
	"us/co/city_of_commerce_city": "The recorded terms disclaim liability and restrict no use.",
	"us/nm/dona_ana": "The recorded terms disclaim warranty, and their one condition concerns resale of hard copy.",
}

/**
 * Decides whether a source's rows are admitted, by its recorded license or a review of its terms.
 */
export function isAdmittedSource(member: string, license: unknown): boolean {
	return member in REVIEWED_OPEN || isAdmittedLicense(license)
}
