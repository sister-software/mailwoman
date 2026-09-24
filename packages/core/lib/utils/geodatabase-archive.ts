/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire one vintage of a published file geodatabase — transfer the archive, unzip it into a `.gdb`
 *   directory, and answer with the directory gdal will open.
 *
 *   the archive is unzipped **into** A `.gdb` directory rather than IN place. These publishers put the
 *   geodatabase's files at the archive's root, and gdal identifies a file geodatabase by the directory
 *   suffix. Unzipping in place produces a pile of `a0000000*.gdbtable` files no driver will open, which
 *   reads as an unsupported format rather than as an extraction that landed one level too high.
 *
 *   the cache is keyed on the product'S own vintage, never on A length probe. The hosts these callers use
 *   answer `head` with http 405 and ignore `Range` — a `curl -r 0-1023` returns http 200 with the whole
 *   body — so "just check the size" starts a real transfer of a file already on disk. Keying on the vintage
 *   the catalogue declares means a re-run against the same vintage never re-transfers, and a new vintage
 *   never overwrites the old one in place.
 *
 *   shared rather than copied because nothing in it is any one product's: it is a cache key, a transfer and
 *   an extraction. What stays with each caller is where the URL came from and what the two names are.
 */

import { PathBuilder, type PathBuilderLike } from "path-ts"

import { tryStat } from "#fs/readers"
import { makeDirectories } from "#fs/writers"
import { runFile } from "#process"
import { streamToDisk } from "#utils/stream-to-disk"

export interface DownloadZippedGeodatabaseOptions {
	/**
	 * The direct file URL, read from the catalogue entry rather than assembled —
	 * these file services key on an opaque id with no relationship to the dataset id.
	 */
	url: string
	/**
	 * The product's ISO revision date.
	 *
	 * The cache is keyed on it.
	 */
	revisionDate: string
	/**
	 * Where vintages are kept.
	 */
	cacheRoot: PathBuilderLike
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
 * The transfer writes to a `.part` file and renames only on a clean finish,
 * so an interrupted run never presents as a complete archive.
 * The same discipline the database build uses, for the same reason.
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
