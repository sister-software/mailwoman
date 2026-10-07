/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire the published file geodatabase — a 70,296,882-byte archive streamed to disk and unzipped.
 *
 *   the transfer, the cache KEY and the extraction live IN `@mailwoman/core/utils`, because none of them is
 *   These download functions share behavior with the BAN source. `downloadZippedGeodatabase` explains
 *   why the archive unpacks into a `.gdb` directory and why the cache uses a vintage instead of a length
 *   probe. `streamToDisk` explains why file transfer uses raw `fetch` instead of `APIClient`.
 *   The two names below belong to this package. Metadata reads around the transfer use `APIClient`;
 *   see `client.ts`.
 *
 *   the host leaves no choice about the cache KEY. It answers `head` with http 405 and ignores `Range`: a
 *   `curl -r 0-1023` against this URL returns http 200 with `size_download=70296882`, the whole file.
 */

import { downloadZippedGeodatabase, type GeodatabaseVintageOptions } from "@mailwoman/core/utils"

/**
 * The resource name the catalogue entry uses for the file geodatabase.
 */
export const NCERM_GEODATABASE_RESOURCE = "National_Coastal_Erosion_Risk_Mapping_NCERM_National_2024.gdb.zip"

/**
 * The unzipped geodatabase directory name.
 */
export const NCERM_GEODATABASE_DIRECTORY = "National_Coastal_Erosion_Risk_Mapping_NCERM_National_2024.gdb"

/**
 * Download and unzip the geodatabase for one product vintage, returning the path of the `.gdb` directory.
 */
export async function downloadCoastalGeodatabase(options: GeodatabaseVintageOptions): Promise<string> {
	return downloadZippedGeodatabase({
		url: options.url,
		revisionDate: options.revisionDate,
		cacheRoot: options.cacheRoot,
		resource: NCERM_GEODATABASE_RESOURCE,
		directory: NCERM_GEODATABASE_DIRECTORY,
		context: "coastal download",
		...(options.onProgress ? { onProgress: options.onProgress } : {}),
	})
}
