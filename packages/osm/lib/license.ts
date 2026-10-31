/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license, credit and notice that apply to every OpenStreetMap database this package builds.
 *
 *   This package's code is licensed under Mailwoman's own terms. ODbL section 2.3(a) excludes the
 *   programs used to make or operate a database from the license. The databases the code builds are
 *   OpenStreetMap Derivative Databases under ODbL 1.0. These constants are the one place the license
 *   and credit are spelled, so the builder's manifest, the notices it prints and the provider's
 *   refusal message agree.
 */

/**
 * The SPDX identifier of the Open Database License that OpenStreetMap data is published under.
 */
export const OSM_LICENSE = "ODbL-1.0"

/**
 * The credit OpenStreetMap asks for wherever its data is used.
 */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors"

/**
 * The OpenStreetMap Foundation page that states the license and the credit.
 */
export const OSM_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright"

/**
 * The license text.
 */
export const ODBL_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

/**
 * The lines the builder prints before and after it writes an OpenStreetMap database.
 *
 * They identify the built file's license and required credit, and the share-alike and database-access
 * terms that apply when the operator publicly uses the file or a database derived from it.
 * They state what the license asks.
 *
 * Whether a given use is public is the operator's determination.
 */
export function osmLicenseNotice(output: string): string[] {
	return [
		`${output} is an OpenStreetMap Derivative Database under the Open Database License 1.0 (${ODBL_URL}).`,
		`Credit "${OSM_ATTRIBUTION}" wherever data from it is shown, with a link to ${OSM_COPYRIGHT_URL}.`,
		"If you publicly use this database, or a database derived from it, ODbL section 4.4 requires that",
		"database to be offered under ODbL, and section 4.6 requires offering it, or a file that reproduces",
		"your changes, to its recipients. A geocoding service built on it must credit OpenStreetMap.",
		"Individual geocoding results are ordinarily insubstantial extracts under the OSMF Geocoding Guideline.",
	]
}
