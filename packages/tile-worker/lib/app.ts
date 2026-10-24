/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The tile Worker's Hono app: PMTiles tiles and TileJSON from R2, terrarium elevation tiles, SQLite byte ranges for
 *   the browser's httpvfs reader, and the caller's approximate location.
 *
 *   Hono matches a regex parameter only when it fills its whole path segment, so a route whose last segment holds a
 *   number and an extension, such as `12905.mvt`, captures the segment and its handler parses it.
 */

import { mailwomanCORS } from "@mailwoman/api-worker/cors"
import { renderWorkerError } from "@mailwoman/api-worker/errors"
import { Hono, type Context, type Handler } from "hono"

import { edgeResponseCache, fromCache, type ResponseCache, type TileWorkerHono } from "#caching"
import { serveDatabase } from "#routes/db"
import { serveGeolocation } from "#routes/geolocation"
import { serveHeartbeat, serveHome } from "#routes/healthcheck"
import { serveTerrariumTile } from "#routes/terrain"
import { serveTile, serveTileMetadata, tileSetOfMetadataFile } from "#routes/tile"

/**
 * Options for {@link createTileWorkerApp}.
 */
export interface TileWorkerAppOptions {
	/**
	 * The response cache the routes read and fill.
	 *
	 * @defaultValue the Workers runtime's edge cache
	 */
	cache?: ResponseCache
}

/**
 * The request headers a preflight to the tile Worker admits.
 */
const ALLOWED_REQUEST_HEADERS = [
	"Accept-Ranges",
	"If-Match",
	"If-Modified-Since",
	"If-None-Match",
	"Range",
	"Server",
	"x-goog-meta-frames",
	"X-Mailwoman-Request",
	"X-Mailwoman-Response",
	"X-Requested-With",
]

/**
 * The scheme of a VS Code webview.
 * A webview previews a map style against these tiles.
 */
const VSCODE_WEBVIEW_PROTOCOL = "vscode-webview:"

/**
 * The MapLibre style editor's origin.
 * The editor loads these tiles into its preview.
 */
const MAPLIBRE_ORIGIN = "https://maplibre.org"

/**
 * Origins the tile Worker answers beyond the Mailwoman sites.
 */
function isTileClientOrigin(origin: string): boolean {
	return origin === MAPLIBRE_ORIGIN || origin.startsWith(VSCODE_WEBVIEW_PROTOCOL)
}

const SEGMENT = {
	tileSetName: "[a-zA-Z0-9_.\\-]+",
	tigerTileSetName: "[a-zA-Z0-9_\\-]+",
	providerTileSetName: "[a-z0-9_\\-]+",
	digits: "\\d+",
	tileFile: "\\d+\\.[a-z0-9]+",
} as const

/**
 * The z/x/tile path suffix every tile route shares.
 */
const TILE_SUFFIX = `/:z{${SEGMENT.digits}}/:x{${SEGMENT.digits}}/:tile{${SEGMENT.tileFile}}`

function tigerTileSetName(c: Context<TileWorkerHono>): string {
	return `tiger/${c.req.param("stateCode")}/${c.req.param("tileSetName")}`
}

function providerTileSetName(c: Context<TileWorkerHono>): string {
	return `providers/${c.req.param("providerID")}/${c.req.param("stateCode")}/${c.req.param("tileSetName")}`
}

/**
 * The tile Worker's routes in match order, as path and handler.
 *
 * The order is the one the Worker has always matched in.
 * No two paths overlap, so every request matches one route whatever the order.
 *
 * A new path that overlaps an earlier one needs a test that pins which route wins.
 */
export const TILE_WORKER_ROUTES: ReadonlyArray<readonly [path: string, handler: Handler<TileWorkerHono>]> = [
	["/db/:file{[a-z0-9_\\-]+\\.[a-z0-9]+}", serveDatabase],
	[
		`/tiger/:stateCode{${SEGMENT.digits}}/:tileSet{${SEGMENT.tigerTileSetName}\\.json}`,
		(c) =>
			serveTileMetadata(c, `tiger/${c.req.param("stateCode")}/${tileSetOfMetadataFile(c.req.param("tileSet") ?? "")}`),
	],
	[
		`/tiger/:stateCode{${SEGMENT.digits}}/:tileSetName{${SEGMENT.tigerTileSetName}}${TILE_SUFFIX}`,
		(c) => serveTile(c, tigerTileSetName(c)),
	],
	[`/terrain/terrarium/:z{${SEGMENT.digits}}/:x{${SEGMENT.digits}}/:tile{${SEGMENT.digits}\\.png}`, serveTerrariumTile],
	[
		`/:tileSet{${SEGMENT.tileSetName}\\.json}`,
		(c) => serveTileMetadata(c, tileSetOfMetadataFile(c.req.param("tileSet") ?? "")),
	],
	[`/:tileSetName{${SEGMENT.tileSetName}}${TILE_SUFFIX}`, (c) => serveTile(c, c.req.param("tileSetName") ?? "")],
	[
		`/providers/:providerID{${SEGMENT.digits}}/:stateCode{${SEGMENT.digits}}/:tileSetName{${SEGMENT.providerTileSetName}}${TILE_SUFFIX}`,
		(c) => serveTile(c, providerTileSetName(c)),
	],
	[
		`/providers/:providerID{${SEGMENT.digits}}/:stateCode{${SEGMENT.digits}}/:tileSet{${SEGMENT.providerTileSetName}\\.json}`,
		(c) =>
			serveTileMetadata(
				c,
				`providers/${c.req.param("providerID")}/${c.req.param("stateCode")}/${tileSetOfMetadataFile(c.req.param("tileSet") ?? "")}`
			),
	],
	["/geolocate", serveGeolocation],
	["/", serveHome],
	["/heartbeat", serveHeartbeat],
]

/**
 * Create the tile Worker's Hono app.
 *
 * Every route answers GET and HEAD.
 * The CORS middleware answers a preflight, and every route reads the response cache before its handler runs.
 */
export function createTileWorkerApp(options: TileWorkerAppOptions = {}): Hono<TileWorkerHono> {
	const cache = options.cache ?? edgeResponseCache()
	const app = new Hono<TileWorkerHono>()

	app.use(
		mailwomanCORS({
			allowMethods: ["GET", "HEAD", "OPTIONS"],
			allowHeaders: ALLOWED_REQUEST_HEADERS,
			exposeHeaders: ["*"],
			alsoAllow: isTileClientOrigin,
		})
	)

	app.use(async (c, next) => {
		c.set("cache", cache)
		await next()
	})

	for (const [path, handler] of TILE_WORKER_ROUTES) {
		app.on(["GET", "HEAD"], path, fromCache, handler)
	}

	app.notFound((c) => new Response(`URL path ${c.req.path} does not match any known route`, { status: 404 }))
	app.onError((error) => renderWorkerError(error))

	return app
}
