/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The origins the app talks to. They are typed URLs rather than strings so a composed URL cannot lose its trailing
 *   slash, and a single object so a staging deployment can swap all three at once.
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
}

/**
 * The production origins: the public R2 bucket the docs page reads today, and the tile worker at its custom domain.
 */
export const PRODUCTION_CONFIG: EarthConfig = {
	dataOriginURL: new URL("https://public.mailwoman.ai/"),
	tileWorkerURL: new URL("https://tiles.mailwoman.ai/"),
	basemapTileJSONURL: new URL("https://tiles.mailwoman.ai/basemap-v4.json"),
}
