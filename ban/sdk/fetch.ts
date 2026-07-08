/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   BAN dump URLs + provenance constants. The Base Adresse Nationale publishes per-département and
 *   national CSV exports at adresse.data.gouv.fr under the Licence Ouverte / Etalab 2.0. We pull the
 *   per-département dumps (`adresses-<dept>.csv.gz`) — the ecosystem's default shard unit — and assemble
 *   the national FR shard from them. These constants keep the build reproducible + the provenance
 *   record honest (the source URL, the license, the required attribution string).
 */

/** The BAN "latest" CSV export root. */
export const BAN_CSV_BASE = "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv"

/** Licence Ouverte / Etalab 2.0 — attribution, NO share-alike (unlike ODbL). */
export const BAN_LICENSE = "Licence Ouverte / Open Licence 2.0 (Etalab)"

/** The attribution string a result resolved through a BAN point must surface. */
export const BAN_ATTRIBUTION = "© les contributeurs de la Base Adresse Nationale (adresse.data.gouv.fr)"

/**
 * The download URL of one département's BAN dump. `dept` is the INSEE département code — `01`…`95`, the Corsica codes
 * `2A`/`2B`, or an overseas code (`971`…`976`). Pass the code exactly as BAN names the file.
 */
export function banDepartementURL(dept: string): string {
	return `${BAN_CSV_BASE}/adresses-${dept}.csv.gz`
}

/** The download URL of the whole-country BAN dump (`adresses-france.csv.gz`). */
export function banNationalURL(): string {
	return `${BAN_CSV_BASE}/adresses-france.csv.gz`
}
