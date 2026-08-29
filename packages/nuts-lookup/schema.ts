/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `nuts.db` read contract. Declared beside the reader and the builder that writes it, so a column added to one is
 *   a compile error against the other.
 */

/**
 * One NUTS region: its identifier, hierarchy level, bounding box, and encoded geometry.
 */
export interface NUTSRegionTable {
	// The column is spelled `nutsId` in the built artifact's DDL, so this name is a string contract with the file
	// rather than ours to choose. Renaming it here would stop matching the database.
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- column name in nuts.db
	nutsId: string
	level: number | null
	minLat: number | null
	maxLat: number | null
	minLon: number | null
	maxLon: number | null
	geom: string
}

/**
 * The tables `nuts.db` carries.
 */
export interface NUTSDatabase {
	nuts_regions: NUTSRegionTable
}
