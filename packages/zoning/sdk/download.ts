/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Acquire the Department's bulk GeoJSON export with raw `fetch` rather than `APIClient`, following the result URL's redirect and keying the cache on the item's own modified date.
 */

import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { streamToDisk } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The file name one vintage's export is kept under.
 */
export const GZT_EXPORT_FILE = "gzt-current-plan.geojson"

export interface DownloadZoningExportOptions {
	/**
	 * The Hub job's `resultUrl`, read rather than assembled because it includes a
	 * generated file id that a hard-coded URL would outlive.
	 */
	url: string
	/**
	 * The product vintage the cache is keyed on.
	 */
	vintage: string
	cacheRoot: PathBuilderLike
	onProgress?: (message: string) => void
}

/**
 * Download the bulk export for one product vintage and return the path of the GeoJSON file, renaming a
 * `.part` file only on a clean finish so an interrupted transfer never presents as a complete export.
 */
export async function downloadZoningExport(options: DownloadZoningExportOptions): Promise<string> {
	const vintageDir = PathBuilder.from(options.cacheRoot)(options.vintage)
	// A string, because the build records the export path it read.
	const exportPath = vintageDir(GZT_EXPORT_FILE).toString()

	if (await tryStat(exportPath)) {
		options.onProgress?.(`export for ${options.vintage} already downloaded`)

		return exportPath
	}

	await makeDirectories(vintageDir)

	await streamToDisk({
		url: options.url,
		destination: exportPath,
		context: "zoning download",
		...(options.onProgress ? { onProgress: options.onProgress } : {}),
	})

	return exportPath
}
