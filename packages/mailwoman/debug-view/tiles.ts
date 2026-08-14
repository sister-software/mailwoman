/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { dataRootPath } from "@mailwoman/core/utils"

/**
 * --tiles flag → $MAILWOMAN_TILES → dataRootPath("tiles", "planet.pmtiles") if it exists → null (degrade).
 *
 * Flag and environment values pass through verbatim — an `https://` archive URL is as valid as a path, and
 * `TileSource.open` reads either. Only the data-root fallback is existence-probed; a URL is never probed here.
 */
export function resolveTilesPath(flagValue?: string): string | null {
	if (flagValue) return flagValue

	if ($public.MAILWOMAN_TILES) return $public.MAILWOMAN_TILES

	const fallback = dataRootPath("tiles", "planet.pmtiles")

	return existsSync(fallback) ? fallback : null
}
