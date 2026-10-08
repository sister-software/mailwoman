/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Raw `fetch` is deliberate for a multi-gigabyte streamed transfer: `APIClient`'s response caching
 *   and pacing do not apply.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { openWriteStream, pipeline, Readable } from "@mailwoman/core/fs/streams"
import { movePath } from "@mailwoman/core/fs/writers"
import { verifyZipIntegrity } from "@mailwoman/core/fs/zip"
import type { PathBuilderLike } from "path-ts"

/**
 * Download `url` to `dest` unless a valid copy is already there.
 *
 * "Valid" means every member's CRC-32 checks out.
 * An interrupted download otherwise leaves a plausible file that fails later inside ogr2ogr.
 */
export async function downloadIfNeeded(url: string, dest: PathBuilderLike): Promise<boolean> {
	if (await pathExists(dest)) {
		try {
			await verifyZipIntegrity(dest)

			return true
		} catch {
			// corrupt cache — re-download
		}
	}

	const tmp = dest + ".tmp"
	const res = await fetch(url, { redirect: "follow" })

	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`)
	await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), openWriteStream(tmp))
	await movePath(tmp, dest)

	return false
}
