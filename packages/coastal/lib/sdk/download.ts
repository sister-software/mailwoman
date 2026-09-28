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

import { downloadZippedGeodatabase } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

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
	cacheRoot: PathBuilderLike
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
