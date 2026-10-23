/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import envPaths, { type Paths } from "env-paths"
import { resolvePath } from "path-ts"

const platformPaths = envPaths("mailwoman", { suffix: "" })

/**
 * Platform-native filesystem defaults used by the typed environment schema.
 *
 * No log root: Mailwoman writes no persistent log of its own, so the platform
 * log directory is not a setting.
 */
export const DefaultMailwomanPaths: Omit<Paths, "log"> = {
	data: resolvePath(platformPaths.data),
	config: resolvePath(platformPaths.config),
	cache: resolvePath(platformPaths.cache),
	temp: resolvePath(platformPaths.temp),
}

/**
 * Paths for published storage assets.
 */
export interface MailwomanWellKnown {
	/**
	 * S3 bucket for storing public assets.
	 */
	readonly PublicBucket: string
	/**
	 * Origin URL for serving tiles.
	 *
	 * @format url
	 */
	readonly TilesURL: string
	/**
	 * Origin URL for serving public assets.
	 *
	 * @format url
	 */
	readonly AssetsURL: string

	/**
	 * The license worker when `MAILWOMAN_LICENSE_URL` is unset.
	 *
	 * @format url
	 */
	readonly LicenseURL: string
}

/**
 * Default values for the well-known storage assets used by Mailwoman.
 */
export const DefaultWellKnown = {
	PublicBucket: "mailwoman-public",
	TilesURL: "https://tiles.mailwoman.ai",
	AssetsURL: "https://public.mailwoman.ai",
	LicenseURL: "https://license.mailwoman.ai",
} as const satisfies MailwomanWellKnown

/**
 * Paths for storage assets not visible to the browser runtime.
 */
export interface ServerStoragePaths {
	/**
	 * S3 bucket for storing tiles.
	 *
	 * This is typically not public and access is typically performed via the tile worker.
	 *
	 * @format alpha-numeric
	 */
	readonly TILES_BUCKET: string

	/**
	 * Prefix within the tiles bucket.
	 *
	 * @format alpha-numeric
	 */
	readonly TILES_PREFIX: string
}

/**
 * Default values for the server storage paths used by Mailwoman.
 */
export const ServerStoragePaths = {
	TILES_BUCKET: "mailwoman-tiles",
	TILES_PREFIX: "tiles",
} as const satisfies ServerStoragePaths
