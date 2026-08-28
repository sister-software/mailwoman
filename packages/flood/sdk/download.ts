/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire the published file geodatabase — a 367 MB archive streamed to disk and unzipped.
 *
 *   THIS IS A FILE TRANSFER, NOT AN API REQUEST, AND IT KEEPS RAW `fetch` ON PURPOSE. The repo's rule
 *   sends HTTP clients through `@mailwoman/core/api`'s `APIClient`, and the rule draws its line at what
 *   that class is for: pacing, bounded retry, response caching and error mapping over small bodies and
 *   repeated calls. None of it applies here. Caching a 367 MB body through a JSON-validating disk cache
 *   would write a second, unreadable copy of a file already on disk; there is nothing to pace, because
 *   this runs once per product vintage; and axios buffers any non-stream response type in memory.
 *   `packages/osm/sdk/fetch.ts` and `packages/tiger/sdk/download.ts` are the two existing transfers that
 *   say the same thing in the same place. The METADATA reads around this one do go through `APIClient` —
 *   see `client.ts`.
 *
 *   FRESHNESS IS THE CATALOGUE'S REVISION DATE, NEVER A LENGTH PROBE. The download host answers `HEAD`
 *   with HTTP 405 and ignores `Range`, returning 200 with the full body — so "just check the size" starts
 *   a real 367 MB transfer. The cached archive is therefore keyed on the product's ISO revision date, and
 *   a vintage already on disk is never re-fetched.
 */

import { execFile } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { streamToDisk } from "@mailwoman/core/utils"

const execFileAsync = promisify(execFile)

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
	 * The direct file URL, read from the catalogue entry rather than assembled — the EA's file service keys on an opaque
	 * id with no relationship to the dataset id.
	 */
	url: string
	/**
	 * The product's ISO revision date. The cache is keyed on it, so a re-run against the same vintage never re-transfers
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
 *
 * Downloads to a `.part` file and renames only on a clean finish, so an interrupted transfer never presents as a
 * complete archive — the same discipline the database build uses, for the same reason.
 */
export async function downloadFloodGeodatabase(options: DownloadGeodatabaseOptions): Promise<string> {
	const vintageDir = join(options.cacheRoot, options.revisionDate)
	const geodatabasePath = join(vintageDir, EA_GEODATABASE_DIRECTORY)

	if (await exists(geodatabasePath)) {
		options.onProgress?.(`geodatabase for ${options.revisionDate} already unzipped`)

		return geodatabasePath
	}

	await mkdir(vintageDir, { recursive: true })

	const archivePath = join(vintageDir, EA_GEODATABASE_RESOURCE)

	if (!(await exists(archivePath))) {
		await streamToDisk({
			url: options.url,
			destination: archivePath,
			context: "flood download",
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
		})
	} else {
		options.onProgress?.(`archive for ${options.revisionDate} already downloaded`)
	}

	options.onProgress?.("unzipping")

	// The archive holds the geodatabase's files at its root rather than inside a `.gdb` directory, so it is unzipped
	// INTO one. GDAL identifies a file geodatabase by the directory suffix; unzipping in place produces a pile of
	// `a0000000*.gdbtable` files no driver will open.
	await mkdir(geodatabasePath, { recursive: true })
	await execFileAsync("unzip", ["-o", "-q", archivePath, "-d", geodatabasePath])

	return geodatabasePath
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false
	)
}
