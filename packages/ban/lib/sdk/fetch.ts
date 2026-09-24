/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * BAN download URLs and provenance metadata. The builder combines per-département CSV exports into
 * a national address-point extract under Licence Ouverte / Etalab 2.0.
 */

/**
 * Root URL for the latest BAN CSV exports.
 */
export const BAN_CSV_BASE = "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv"

/**
 * BAN's Licence Ouverte / Open Licence 2.0 (Etalab).
 */
export const BAN_LICENSE = "Licence Ouverte / Open Licence 2.0 (Etalab)"

/**
 * Attribution required for results resolved from BAN points.
 */
export const BAN_ATTRIBUTION = "© les contributeurs de la Base Adresse Nationale (adresse.data.gouv.fr)"

/**
 * Build the dump URL for an INSEE département code as BAN names it.
 */
export function banDepartementURL(dept: string): string {
	return `${BAN_CSV_BASE}/adresses-${dept}.csv.gz`
}

/**
 * Build the URL for the national BAN dump.
 */
export function banNationalURL(): string {
	return `${BAN_CSV_BASE}/adresses-france.csv.gz`
}
