/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `un-locode.db` read contract. Declared beside the reader and the builder that writes it, so a column added to
 *   one is a compile error against the other.
 */

/**
 * One UN/LOCODE entry: the country and location codes that form its key, the place name in raw and folded form, and the
 * coordinate pair when the source carries one.
 */
export interface UNLocodeTable {
	country: string
	location: string
	name: string | null
	nameNorm: string | null
	lat: number | null
	lon: number | null
}

/**
 * The tables `un-locode.db` carries.
 */
export interface UNLocodeDatabase {
	un_locode: UNLocodeTable
}
