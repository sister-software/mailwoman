/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire the published file geodatabase — a 367 MB archive streamed to disk and unzipped.
 *
 *   the transfer, the cache KEY and the extraction live IN `@mailwoman/core/utils`, because none of them is
 *   this product's: `downloadZippedGeodatabase` carries why the archive unzips into a `.gdb` directory and
 *   why the cache is keyed on a vintage rather than a length probe, and `streamToDisk` carries why a file
 *   transfer keeps raw `fetch` instead of going through `APIClient`. What is flood's, and stays here, is the
 *   two names below. The metadata reads around this transfer do go through `APIClient` — see `client.ts`.
 *
 *   the host leaves no choice about the cache KEY. It answers `head` with http 405 and ignores `Range`,
 *   returning 200 with the full body — so "just check the size" starts a real 367 MB transfer.
 */

import { downloadZippedGeodatabase } from "@mailwoman/core/utils"

/**
 * The resource name the catalogue entry uses for the file geodatabase.
 */
export const EA_GEODATABASE_RESOURCE = "Flood_Map_for_Planning_Flood_Zones.gdb.zip"

/**
 * The unzipped geodatabase directory name.
 */
export const EA_GEODATABASE_DIRECTORY = "Flood_Map_for_Planning_Flood_Zones.gdb"

export interface DownloadGeodatabaseOptions {
	/**
	 * The direct file URL, read from the catalogue entry rather than assembled —
	 * the EA's file service keys on an opaque id with no relationship to the dataset id.
	 */
	url: string
	/**
	 * The product's ISO revision date. The cache is keyed on it, so a re-run against the same
	 * vintage never re-transfers and a new vintage never overwrites the old one in place.
	 */
	revisionDate: string
	/**
	 * Where vintages are kept.
	 */
	cacheRoot: string
	onProgress?: (message: string) => void
}

/**
 * Download and unzip the geodatabase for one product vintage, returning the path of the `.gdb` directory.
 */
export async function downloadFloodGeodatabase(options: DownloadGeodatabaseOptions): Promise<string> {
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
