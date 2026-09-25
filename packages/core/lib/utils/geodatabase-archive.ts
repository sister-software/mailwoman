/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Downloads one vintage of a published file geodatabase and unzips it into a `.gdb` directory for GDAL.
 *
 *   The publishers put the geodatabase files at the archive root, and GDAL recognizes a file geodatabase by its
 *   `.gdb` directory suffix. The archive is therefore extracted into a named `.gdb` directory.
 *
 *   The cache is keyed on the catalogue's revision date. The hosts reject `HEAD` requests and ignore `Range`, so
 *   checking the remote size would download the whole file. Each vintage gets its own directory.
 */

import { PathBuilder, type PathBuilderLike } from "path-ts"

import { tryStat } from "#fs/readers"
import { makeDirectories } from "#fs/writers"
import { runFile } from "#process"
import { streamToDisk } from "#utils/stream-to-disk"

/**
 * Options for {@link downloadZippedGeodatabase}.
 */
export interface DownloadZippedGeodatabaseOptions {
	/**
	 * The direct file URL from the catalogue entry.
	 *
	 * The URL uses an opaque file ID, so callers cannot build it from the dataset ID.
	 */
	url: string
	/**
	 * The product's ISO revision date, which keys the cache.
	 */
	revisionDate: string
	/**
	 * The directory that holds one subdirectory per vintage.
	 */
	cacheRoot: PathBuilderLike
	/**
	 * The archive's file name from the catalogue entry.
	 */
	resource: string
	/**
	 * The `.gdb` directory name to extract into.
	 */
	directory: string
	/**
	 * A label for the caller in error messages, such as `"flood download"`.
	 */
	context: string
	onProgress?: (message: string) => void
}

/**
 * Downloads and unzips the geodatabase for one product vintage and returns the `.gdb` directory path.
 *
 * An existing `.gdb` directory or archive for the vintage is reused.
 * The download writes to a `.part` file and renames it only on success,
 * so an interrupted download leaves no archive behind.
 */
export async function downloadZippedGeodatabase(options: DownloadZippedGeodatabaseOptions): Promise<string> {
	const vintageDir = PathBuilder.from(options.cacheRoot)(options.revisionDate)
	const geodatabasePath = vintageDir(options.directory)

	if (await tryStat(geodatabasePath)) {
		options.onProgress?.(`geodatabase for ${options.revisionDate} already unzipped`)

		return geodatabasePath.toString()
	}

	await makeDirectories(vintageDir)

	const archivePath = vintageDir(options.resource)

	if (await tryStat(archivePath)) {
		options.onProgress?.(`archive for ${options.revisionDate} already downloaded`)
	} else {
		await streamToDisk({
			url: options.url,
			destination: archivePath,
			context: options.context,
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
		})
	}

	options.onProgress?.("unzipping")

	await makeDirectories(geodatabasePath)
	await runFile("unzip", ["-o", "-q", archivePath, "-d", geodatabasePath])

	return geodatabasePath.toString()
}
