/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which jurisdictions have a UPU S42 addressing template, and when the template group grew.
 *
 *   S42 is not a country's domestic addressing system. USPS Publication 28, Royal Mail's addressing rules, La
 *   Poste's NF Z 10-011 and the South African Post Office's system each exist independently of it. What S42 does
 *   is map an existing national structure into a common set of international elements, and UPU builds each
 *   template with that country's own representative, tests it against representative address forms, and has the
 *   country approve it before publication.
 *
 *   That procedure is why a template is worth more to this repository than an international formatting
 *   recommendation would be. For a jurisdiction in {@linkcode S42_TEMPLATE_JURISDICTIONS} there exists a
 *   crosswalk of that country's own address semantics which the country approved, whether or not anybody in that
 *   country posts mail by it. A jurisdiction absent from the list has no such crosswalk, which is a different
 *   statement from having one nobody here has read.
 */

/**
 * The jurisdictions UPU's current template inventory covers, as ISO 3166-1 alpha-2 codes.
 *
 * **Unretrieved.** The list was supplied by the operator on 2026-09-30 and UPU's inventory
 * has not been fetched, so this records a claim rather than a measurement.
 * Retrieving the inventory and comparing it against this constant is the step that turns it into one.
 *
 * The count and the internal consistency were checked: 72 distinct codes, every one a
 * well-formed alpha-2, and every member of both earlier cohorts present.
 */
export const S42_TEMPLATE_JURISDICTIONS: readonly string[] = [
	"AU",
	"AZ",
	"BA",
	"BE",
	"BG",
	"BH",
	"BR",
	"BW",
	"BY",
	"CA",
	"CL",
	"CN",
	"CO",
	"CR",
	"CU",
	"CZ",
	"DE",
	"DJ",
	"DZ",
	"EC",
	"ES",
	"FI",
	"FR",
	"GB",
	"GE",
	"GR",
	"GT",
	"ID",
	"IR",
	"IT",
	"JM",
	"KE",
	"KM",
	"KR",
	"KY",
	"KZ",
	"LC",
	"LT",
	"MA",
	"MD",
	"MK",
	"MM",
	"MN",
	"MW",
	"MY",
	"NA",
	"NL",
	"NZ",
	"OM",
	"PL",
	"PT",
	"QA",
	"RO",
	"RS",
	"SA",
	"SK",
	"TH",
	"TN",
	"TR",
	"TT",
	"TZ",
	"UA",
	"UG",
	"US",
	"UY",
	"UZ",
	"VC",
	"VE",
	"VN",
	"ZA",
	"ZM",
	"ZW",
]

/**
 * The eleven jurisdictions UPU described in 2006 as using the S42 standard.
 *
 * Same provenance as {@linkcode S42_TEMPLATE_JURISDICTIONS}: supplied rather than retrieved.
 */
export const S42_COHORT_2006: readonly string[] = ["AU", "BR", "CL", "FI", "FR", "GB", "MA", "NL", "NZ", "US", "VE"]

/**
 * The six jurisdictions the recognized group had added by 2010, taking it to seventeen.
 */
export const S42_COHORT_2010_ADDITIONS: readonly string[] = ["CA", "DE", "IT", "PT", "SA", "ZA"]

/**
 * When a jurisdiction entered the S42 template group.
 *
 * The cohort says how long the crosswalk has been in place rather than how widely the country uses it.
 * An early cohort member is one whose template has had longer to be revised against real mail.
 */
export const S42Cohort = {
	/**
	 * Named in UPU's 2006 description of countries using the standard.
	 */
	Original2006: "2006",
	/**
	 * Added to the recognized group by 2010.
	 */
	Added2010: "2010",
	/**
	 * Present in the current inventory, with no earlier cohort recorded here.
	 */
	Current: "current",
} as const

/**
 * One of the {@link S42Cohort} values.
 */
export type S42Cohort = (typeof S42Cohort)[keyof typeof S42Cohort]

const TEMPLATES = new Set(S42_TEMPLATE_JURISDICTIONS)
const COHORT_2006 = new Set(S42_COHORT_2006)
const COHORT_2010 = new Set(S42_COHORT_2010_ADDITIONS)

/**
 * Returns the cohort a jurisdiction's S42 template belongs to, or `null`
 * when the inventory covers no template for it.
 *
 * `null` states that no approved crosswalk exists for that country.
 * It does not state that the country lacks an addressing system, which is what
 * its own postal authority publishes.
 */
export function s42CohortForJurisdiction(iso2: string | null | undefined): S42Cohort | null {
	if (!iso2) return null

	const code = iso2.trim().toUpperCase()

	if (!TEMPLATES.has(code)) return null

	if (COHORT_2006.has(code)) return S42Cohort.Original2006

	if (COHORT_2010.has(code)) return S42Cohort.Added2010

	return S42Cohort.Current
}
