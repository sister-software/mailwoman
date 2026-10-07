/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route definitions + handlers for the Photon-compatible surface. The OpenAPI document is
 *   emitted from these definitions, so no handwritten spec exists. Handlers parse params from
 *   the `legacyQuery` express-shaped view. The zod query schemas drive only the emitted document.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { asString, legacyQuery, withEngineStamp } from "@mailwoman/api-kit"
import type { EngineStamp } from "@mailwoman/core/license"

import type { PhotonEngine, PhotonFeatureCollection, PhotonReverseParams, PhotonSearchParams } from "#engine"
import { photonToSchemaOrg } from "#projection"
import { PhotonMessageCollectionSchema, PhotonResponseSchema, reverseQueryParams, searchQueryParams } from "#schema"

const MIN_LATITUDE = -90

const MAX_LATITUDE = 90

const MIN_LONGITUDE = -180

const MAX_LONGITUDE = 180

const DEFAULT_LIMIT = 15

const EMPTY: PhotonFeatureCollection = { type: "FeatureCollection", features: [] }

function asStringArray(raw: unknown): string[] | null {
	if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string")
	const s = asString(raw)

	return s ? [s] : null
}

/**
 * A friendly html landing page for `GET /`.
 *
 * Upstream komoot/photon serves no root page, so there is no wire interface to match.
 * Relative example URLs resolve against whatever host and port serve this.
 */
const ROOT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@mailwoman/photon</title>
<style>
:root { color-scheme: light dark }
body { font: 16px/1.6 system-ui, -apple-system, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem }
h1 { font-size: 1.3rem; margin: 0 0 .5rem }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
ul { padding-left: 1.2rem }
li { margin: .4rem 0 }
a { color: #2563eb }
.q { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
footer { margin-top: 2rem; font-size: .9rem; opacity: .8 }
</style>
</head>
<body>
<h1>@mailwoman/photon</h1>
<p>A Photon-compatible autocomplete geocoding API — the same <code>/api</code> and <code>/reverse</code> interface, served from a SQLite gazetteer instead of an Elasticsearch cluster.</p>
<p>Try a query:</p>
<ul>
<li><a class="q" href="/api?q=berlin&amp;limit=3">/api?q=berlin&amp;limit=3</a></li>
<li><a class="q" href="/api?q=1600+pennsylvania+ave&amp;limit=1">/api?q=1600+pennsylvania+ave&amp;limit=1</a></li>
<li><a class="q" href="/reverse?lat=52.52&amp;lon=13.405">/reverse?lat=52.52&amp;lon=13.405</a></li>
</ul>
<footer><a href="https://mailwoman.ai/docs/developers/get-started/what-mailwoman-is">What Mailwoman is</a> &middot; <a href="https://mailwoman.ai/demo">Live demo</a></footer>
</body>
</html>
`

const messageContent = (description: string) => ({
	description,
	content: { "application/json": { schema: PhotonMessageCollectionSchema } },
})

const collectionResponses = {
	200: {
		description: "A GeoJSON FeatureCollection (or schema.org Place[] when format=jsonld).",
		content: { "application/json": { schema: PhotonResponseSchema } },
	},
	400: messageContent("A required or malformed parameter."),
	500: messageContent("An unexpected engine fault. An empty FeatureCollection with a message, never a crash."),
	501: messageContent("The backing engine method is not wired for this deployment."),
}

const rootRoute = createRoute({
	method: "get",
	path: "/",
	operationId: "getRoot",
	summary: "Landing page",
	tags: ["meta"],
	responses: { 200: { description: "HTML landing page.", content: { "text/html": { schema: z.string() } } } },
})

const searchRoute = createRoute({
	method: "get",
	path: "/api",
	operationId: "search",
	summary: "Forward / autocomplete geocoding",
	tags: ["geocoding"],
	request: { query: searchQueryParams },
	responses: collectionResponses,
})

const reverseRoute = createRoute({
	method: "get",
	path: "/reverse",
	operationId: "reverse",
	summary: "Reverse geocoding",
	tags: ["geocoding"],
	request: { query: reverseQueryParams },
	responses: collectionResponses,
})

/**
 * Register the Photon-compatible routes against an injected engine.
 */
export function registerPhotonRoutes(app: OpenAPIHono, engine: PhotonEngine, stamp?: EngineStamp): void {
	app.openapi(rootRoute, (c) => c.html(ROOT_HTML))

	app.openapi(searchRoute, async (c) => {
		if (!engine.search) return c.json({ ...EMPTY, message: "search not implemented" }, 501)
		const q = legacyQuery(c)
		const query = asString(q["q"])

		if (!query) return c.json({ ...EMPTY, message: "q is required" }, 400)

		const params: PhotonSearchParams = {
			q: query,
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			lang: asString(q["lang"]),
			lat: q["lat"] != null ? Number(q["lat"]) : undefined,
			lon: q["lon"] != null ? Number(q["lon"]) : undefined,
			osmTag: asStringArray(q["osm_tag"]),
			layer: asStringArray(q["layer"]),
		}

		const collection = await engine.search(params)

		// `format=jsonld` re-serializes the FeatureCollection as schema.org `Place[]` JSON-LD.
		if (asString(q["format"]) === "jsonld") {
			return c.json(photonToSchemaOrg(collection), 200)
		}

		return c.json(withEngineStamp(collection, stamp), 200)
	})

	app.openapi(reverseRoute, async (c) => {
		if (!engine.reverse) return c.json({ ...EMPTY, message: "reverse not implemented" }, 501)
		const q = legacyQuery(c)
		const lat = Number(q["lat"])
		const lon = Number(q["lon"])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return c.json({ ...EMPTY, message: "lat and lon are required" }, 400)
		}

		if (lat < MIN_LATITUDE || lat > MAX_LATITUDE || lon < MIN_LONGITUDE || lon > MAX_LONGITUDE) {
			return c.json({ ...EMPTY, message: "lat must be in [-90, 90] and lon in [-180, 180]" }, 400)
		}

		const params: PhotonReverseParams = {
			lat,
			lon,
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			lang: asString(q["lang"]),
			radius: q["radius"] != null ? Number(q["radius"]) : undefined,
		}

		const collection = await engine.reverse(params)

		// `format=jsonld` re-serializes the reverse FeatureCollection as schema.org `Place[]` JSON-LD.
		if (asString(q["format"]) === "jsonld") {
			return c.json(photonToSchemaOrg(collection), 200)
		}

		return c.json(withEngineStamp(collection, stamp), 200)
	})
}
