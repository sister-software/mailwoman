/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire one vintage of a published file geodatabase — transfer the archive, unzip it into a `.gdb`
 *   directory, and answer with the directory GDAL will open.
 *
 *   THE ARCHIVE IS UNZIPPED **INTO** A `.gdb` DIRECTORY RATHER THAN IN PLACE. These publishers put the
 *   geodatabase's files at the archive's ROOT, and GDAL identifies a file geodatabase by the DIRECTORY
 *   SUFFIX. Unzipping in place produces a pile of `a0000000*.gdbtable` files no driver will open, which
 *   reads as an unsupported format rather than as an extraction that landed one level too high.
 *
 *   THE CACHE IS KEYED ON THE PRODUCT'S OWN VINTAGE, NEVER ON A LENGTH PROBE. The hosts these callers use
 *   answer `HEAD` with HTTP 405 and ignore `Range` — a `curl -r 0-1023` returns HTTP 200 with the whole
 *   body — so "just check the size" starts a real transfer of a file already on disk. Keying on the vintage
 *   the catalogue declares means a re-run against the same vintage never re-transfers, and a new vintage
 *   never overwrites the old one in place.
 *
 *   SHARED RATHER THAN COPIED because nothing in it is any one product's: it is a cache key, a transfer and
 *   an extraction. What stays with each caller is where the URL came from and what the two names are.
 */

import { join } from "path-ts"

import { tryStat } from "#fs/readers"
import { makeDirectories } from "#fs/writers"
import { runFile } from "#process"
import { streamToDisk } from "#utils/stream-to-disk"

export interface DownloadZippedGeodatabaseOptions {
	/**
	 * The direct file URL, read from the catalogue entry rather than assembled — these file services key on an opaque id
	 * with no relationship to the dataset id.
	 */
	url: string
	/**
	 * The product's ISO revision date. The cache is keyed on it.
	 */
	revisionDate: string
	/**
	 * Where vintages are kept.
	 */
	cacheRoot: string
	/**
	 * The archive's file name, as the catalogue entry names the resource.
	 */
	resource: string
	/**
	 * The `.gdb` directory name the archive's contents are extracted into.
	 */
	directory: string
	/**
	 * Names the caller in the refusal, e.g. `"flood download"`.
	 */
	context: string
	onProgress?: (message: string) => void
}

/**
 * Download and unzip the geodatabase for one product vintage, returning the path of the `.gdb` directory.
 *
 * The transfer writes to a `.part` file and renames only on a clean finish, so an interrupted run never presents as a
 * complete archive — the same discipline the database build uses, for the same reason.
 */
export async function downloadZippedGeodatabase(options: DownloadZippedGeodatabaseOptions): Promise<string> {
	const vintageDir = join(options.cacheRoot, options.revisionDate)
	const geodatabasePath = join(vintageDir, options.directory)

	if (await tryStat(geodatabasePath)) {
		options.onProgress?.(`geodatabase for ${options.revisionDate} already unzipped`)

		return geodatabasePath
	}

	await makeDirectories(vintageDir)

	const archivePath = join(vintageDir, options.resource)

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

	return geodatabasePath
}
