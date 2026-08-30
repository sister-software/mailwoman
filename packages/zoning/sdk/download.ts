/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Acquire the Department's bulk GeoJSON export — a 247,452,342-byte file streamed to disk.
 *
 *   THIS IS A FILE TRANSFER, NOT AN API REQUEST, AND IT KEEPS RAW `fetch` ON PURPOSE. The repo's rule sends
 *   HTTP clients through `@mailwoman/core/api`'s `APIClient`, and the rule draws its line at what that class
 *   is for: pacing, bounded retry, response caching and error mapping over small bodies and repeated calls.
 *   None of it applies here. Caching a 247 MB body through a JSON-validating disk cache would write a second,
 *   unreadable copy of a file already on disk; there is nothing to pace, because this runs once per product
 *   vintage; and axios buffers any non-stream response type in memory. `packages/osm/sdk/fetch.ts`,
 *   `packages/tiger/sdk/download.ts`, `packages/flood/sdk/download.ts` and `packages/coastal/sdk/download.ts`
 *   are the existing transfers that say the same thing in the same place. The JOB that produces this URL, and
 *   every other metadata read around it, DO go through `APIClient` — see `client.ts`.
 *
 *   THE RESULT URL REDIRECTS AND THE FETCH MUST FOLLOW IT. The Hub download job answers
 *   `{"status":"Completed","resultUrl":…}`; the result URL itself 302s to the generated file. Node's `fetch`
 *   follows redirects by default, and the option is passed explicitly anyway — a transfer that stopped at the
 *   redirect would write a short body to disk and report a successful download.
 *
 *   FRESHNESS IS THE ITEM'S OWN MODIFIED DATE, NEVER A LENGTH PROBE. The cache is keyed on the vintage the
 *   item declares, so a re-run against the same vintage never re-transfers and a new vintage never overwrites
 *   the old one in place.
 */

import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { streamToDisk } from "@mailwoman/core/utils"
import { join } from "@mailwoman/platform/path"

/**
 * The file name one vintage's export is kept under.
 */
export const GZT_EXPORT_FILE = "gzt-current-plan.geojson"

export interface DownloadZoningExportOptions {
	/**
	 * The Hub job's `resultUrl`, read rather than assembled — it carries a generated file id with no relationship to the
	 * item id, so a hard-coded URL survives a republish by pointing at a file that is no longer the product.
	 */
	url: string
	/**
	 * The product vintage the cache is keyed on.
	 */
	vintage: string
	cacheRoot: string
	onProgress?: (message: string) => void
}

/**
 * Download the bulk export for one product vintage, returning the path of the GeoJSON file.
 *
 * Downloads to a `.part` file and renames only on a clean finish, so an interrupted transfer never presents as a
 * complete export — the same discipline the database build uses, for the same reason.
 */
export async function downloadZoningExport(options: DownloadZoningExportOptions): Promise<string> {
	const vintageDir = join(options.cacheRoot, options.vintage)
	const exportPath = join(vintageDir, GZT_EXPORT_FILE)

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
