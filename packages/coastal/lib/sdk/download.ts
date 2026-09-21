/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire the published file geodatabase — a 70,296,882-byte archive streamed to disk and unzipped.
 *
 *   the transfer, the cache KEY and the extraction live IN `@mailwoman/core/utils`, because none of them is
 *   this product's: `downloadZippedGeodatabase` carries why the archive unzips into a `.gdb` directory and
 *   why the cache is keyed on a vintage rather than a length probe, and `streamToDisk` carries why a file
 *   transfer keeps raw `fetch` instead of going through `APIClient`. What is coastal's, and stays here, is
 *   the two names below. The metadata reads around this transfer do go through `APIClient` — see
 *   `client.ts`.
 *
 *   the host leaves no choice about the cache KEY. It answers `head` with http 405 and ignores `Range`: a
 *   `curl -r 0-1023` against this URL returns http 200 with `size_download=70296882`, the whole file.
 */

import { downloadZippedGeodatabase } from "@mailwoman/core/utils"

/**
 * The resource name the catalogue entry uses for the file geodatabase.
 */
export const NCERM_GEODATABASE_RESOURCE = "National_Coastal_Erosion_Risk_Mapping_NCERM_National_2024.gdb.zip"

/**
 * The unzipped geodatabase directory name.
 */
export const NCERM_GEODATABASE_DIRECTORY = "National_Coastal_Erosion_Risk_Mapping_NCERM_National_2024.gdb"

export interface DownloadGeodatabaseOptions {
	/**
	 * The direct file URL, read from the catalogue entry rather than assembled —
	 * the EA's file service keys on an opaque id with no relationship to the dataset id.
	 */
	url: string
	/**
	 * The product's ISO revision date.
	 *
	 * The cache is keyed on it, so a re-run against the same vintage never re-transfers
	 * and a new vintage never overwrites the old one in place.
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
export async function downloadCoastalGeodatabase(options: DownloadGeodatabaseOptions): Promise<string> {
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
