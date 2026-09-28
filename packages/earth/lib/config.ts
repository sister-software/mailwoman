/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The origins the app talks to are typed URLs. A composed URL cannot lose its trailing slash.
 *   One object lets a staging deployment swap all three at once.
 */

export interface EarthConfig {
	/**
	 * The public, unauthenticated bucket every model and gazetteer artifact resolves against.
	 */
	dataOriginURL: URL
	/**
	 * The tile worker serving the basemap and overlay tiles.
	 */
	tileWorkerURL: URL
	/**
	 * The basemap's TileJSON, on the tile worker.
	 */
	basemapTileJSONURL: URL
	/**
	 * Same-origin base for the staged sql.js-httpvfs runtime files (the UMD, the worker and the wasm).
	 *
	 * A worker script has to come from the page's own origin.
	 * This is a path on that origin, rather than a URL on the data origin.
	 */
	sqljsBaseURL: string
}

/**
 * The production origins: the public R2 bucket that serves every artifact
 * and the tile worker's custom domain.
 *
 * The sql.js files are staged under `public/` by the build.
 */
export const PRODUCTION_CONFIG: EarthConfig = {
	dataOriginURL: new URL("https://public.mailwoman.ai/"),
	tileWorkerURL: new URL("https://tiles.mailwoman.ai/"),
	basemapTileJSONURL: new URL("https://tiles.mailwoman.ai/basemap-v4.json"),
	sqljsBaseURL: "/sqljs",
}
