/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { $public } from "@mailwoman/core/env"
import { pathExists } from "@mailwoman/core/fs/readers"
import { dataRootPath } from "@mailwoman/core/utils"
import { resolvePath } from "path-ts"

/**
 * --tiles flag → $MAILWOMAN_TILES → dataRootPath("tiles", "planet.pmtiles") if it exists → null (degrade).
 *
 * Flag and environment values pass through verbatim — an `https://` archive URL is as valid as a path, and
 * `TileSource.open` reads either. Only the data-root fallback is existence-probed; a URL is never probed here.
 */
export async function resolveTilesPath(flagValue?: string): Promise<string | null> {
	if (flagValue) return flagValue

	if ($public.MAILWOMAN_TILES) return $public.MAILWOMAN_TILES

	const fallback = dataRootPath("tiles", "planet.pmtiles")

	return (await pathExists(fallback)) ? resolvePath(fallback) : null
}
