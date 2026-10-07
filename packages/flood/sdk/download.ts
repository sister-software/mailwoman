/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire the published file geodatabase — a 367 MB archive streamed to disk and unzipped.
 *
 *   the transfer, the cache KEY and the extraction live IN `@mailwoman/core/utils`, because none of them is
 *   `downloadZippedGeodatabase` documents the `.gdb` extraction and vintage-based cache key.
 *   The cache uses a vintage instead of a length probe.
 *   `streamToDisk` documents why file transfers use raw `fetch` instead of `APIClient`.
 *   This module owns the two functions below. Metadata reads around the transfer use `APIClient`; see `client.ts`.
 *
 *   the host leaves no choice about the cache KEY. It answers `head` with http 405 and ignores `Range`,
 *   returning 200 with the full body — so "just check the size" starts a real 367 MB transfer.
 */

import { downloadZippedGeodatabase, type GeodatabaseVintageOptions } from "@mailwoman/core/utils"

/**
 * The resource name the catalogue entry uses for the file geodatabase.
 */
export const EA_GEODATABASE_RESOURCE = "Flood_Map_for_Planning_Flood_Zones.gdb.zip"

/**
 * The unzipped geodatabase directory name.
 */
export const EA_GEODATABASE_DIRECTORY = "Flood_Map_for_Planning_Flood_Zones.gdb"

/**
 * Download and unzip the geodatabase for one product vintage, returning the path of the `.gdb` directory.
 */
export async function downloadFloodGeodatabase(options: GeodatabaseVintageOptions): Promise<string> {
	return downloadZippedGeodatabase({
		url: options.url,
		revisionDate: options.revisionDate,
		cacheRoot: options.cacheRoot,
		resource: EA_GEODATABASE_RESOURCE,
		directory: EA_GEODATABASE_DIRECTORY,
		context: "flood download",
		...(options.onProgress ? { onProgress: options.onProgress } : {}),
	})
}
