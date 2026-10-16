/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Ordnance Survey Downloads API's record of one downloadable archive.
 *
 *   The API serves OS OpenData products without authentication. `GET /products/<id>/downloads`
 *   lists one record per archive, and every OS product fetcher in this repository reads that list.
 */

/**
 * The root of the OS Downloads API.
 */
export const OS_DOWNLOADS_API_BASE = "https://api.os.uk/downloads/v1"

/**
 * One archive as `GET /products/<id>/downloads` lists it.
 */
export interface OSDownload {
	/**
	 * The OS-published MD5 of the archive.
	 */
	md5: string
	/**
	 * The archive size in bytes.
	 */
	size: number
	/**
	 * The download URL.
	 * It redirects to a CDN object.
	 */
	url: string
	/**
	 * The archive format, such as `CSV`, `GML` or `GeoPackage`.
	 */
	format: string
	/**
	 * The coverage area, such as `GB` or a 100 km grid square.
	 */
	area: string
	/**
	 * The archive file name, such as `codepo_gb.zip`.
	 */
	fileName: string
}
