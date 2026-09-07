/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The feature the app has selected: what the panel shows and the camera frames. It is the subset of the
 *   pipeline's nomenclature record a tile or the search artifact carries; a click and a deep link both produce one.
 */

export interface SelectedFeature {
	/**
	 * The pipeline's stable feature id, the one in `/feature/<id>`.
	 */
	id: string
	name: string
	featureType: string
	featureTypeCode?: string
	diameterKm?: number
	/**
	 * East-positive, −180..180.
	 */
	centerLon: number
	centerLat: number
	origin?: string
	approvalStatus?: string
	/**
	 * `YYYY-MM-DD`.
	 */
	approvalDate?: string
}

const COORDINATE_DECIMALS = 4

/**
 * A coordinate pair as the panel prints it: four decimals, hemisphere letters, the longitude east-positive as every
 * artifact carries it. `0` takes the positive letter.
 */
export function formatCoordinates(centerLon: number, centerLat: number): string {
	const lat = `${Math.abs(centerLat).toFixed(COORDINATE_DECIMALS)}° ${centerLat < 0 ? "S" : "N"}`
	const lon = `${Math.abs(centerLon).toFixed(COORDINATE_DECIMALS)}° ${centerLon < 0 ? "W" : "E"}`

	return `${lat}, ${lon}`
}

/**
 * A diameter as the panel prints it, or null when the source gives none.
 */
export function formatDiameter(diameterKm: number | undefined): string | null {
	if (diameterKm === undefined) return null

	return `${diameterKm.toLocaleString("en-US", { maximumFractionDigits: 2 })} km`
}
