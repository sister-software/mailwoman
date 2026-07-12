/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route definitions + handlers for the Photon-compatible surface. The OpenAPI document is
 *   emitted from these definitions — no handwritten spec. Handlers parse params from the
 *   `legacyQuery` express-shaped view; the zod query schemas drive only the emitted document.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"

import {
	type PhotonEngine,
	type PhotonFeatureCollection,
	type PhotonReverseParams,
	type PhotonSearchParams,
} from "./engine.ts"
import { photonToSchemaOrg } from "./projection.ts"
import {
	PhotonFeatureCollectionSchema,
	PhotonMessageCollectionSchema,
	reverseQueryParams,
	searchQueryParams,
} from "./schema.ts"

const DEFAULT_LIMIT = 15

const EMPTY: PhotonFeatureCollection = { type: "FeatureCollection", features: [] }

function asString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length > 0 ? raw : undefined
}

function asStringArray(raw: unknown): string[] | undefined {
	if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string")
	const s = asString(raw)

	return s ? [s] : undefined
}

/**
 * Express's `req.query` shape: `string` for a single value, `string[]` for repeats. The legacy parsing helpers
 * (`asString`, `asStringArray`, `Number(...)`) — and their observable degenerate behaviors (repeated `q` → 400,
 * repeated `lat` → NaN → 400) — key off exactly this shape, so the handlers consume it unchanged. Do NOT dedup or
 * canonicalize here: photon's repeatable params (`osm_tag`, `layer`) are contract, and its duplicate-param 400s are
 * contract too (unlike libpostal, where duplicates were never-contract — see the phase-1 adjudications).
 * Null-prototype, matching express-simple's req.query shape (a repeated ?**proto**= param must create an own property,
 * not reparent the object).
 */
function legacyQuery(c: Context): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = Object.create(null)

	for (const [key, values] of Object.entries(c.req.queries())) {
		out[key] = values.length === 1 ? values[0]! : values
	}

	return out
}

/**
 * A friendly HTML landing page for `GET /` (#1022). Upstream komoot/photon serves no root page, so there's no wire
 * contract to match — this is pure courtesy: a browser visitor (or an evaluator kicking the tires) who pastes the bare
 * host in gets a one-glance orientation with clickable example queries instead of Express's `Cannot GET /` 404, which
 * reads as "the service is broken". Relative example URLs so they resolve against whatever host/port serves this.
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
<p>A Photon-compatible autocomplete geocoding API — the same <code>/api</code> and <code>/reverse</code> contract, served from a SQLite gazetteer instead of an Elasticsearch cluster.</p>
<p>Try a query:</p>
<ul>
<li><a class="q" href="/api?q=berlin&amp;limit=3">/api?q=berlin&amp;limit=3</a></li>
<li><a class="q" href="/api?q=1600+pennsylvania+ave&amp;limit=1">/api?q=1600+pennsylvania+ave&amp;limit=1</a></li>
<li><a class="q" href="/reverse?lat=52.52&amp;lon=13.405">/reverse?lat=52.52&amp;lon=13.405</a></li>
</ul>
<footer><a href="https://mailwoman.sister.software/docs/concepts/switching-from-photon">Switching from Photon</a> &middot; <a href="https://mailwoman.sister.software/demo">Live demo</a></footer>
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
		content: { "application/json": { schema: PhotonFeatureCollectionSchema } },
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

/** Register the Photon-compatible routes against an injected engine. */
export function registerPhotonRoutes(app: OpenAPIHono, engine: PhotonEngine): void {
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

		// #1052: `format=jsonld` re-serializes the SAME FeatureCollection as schema.org `Place[]` JSON-LD. The
		// declared 200 schema documents only the FeatureCollection shape (matching the legacy yaml — see the
		// Task 4 adjudication); the jsonld branch's differing runtime shape is a local cast at the boundary,
		// never a wire-behavior change (api-kit's `openapi.ts` sets the precedent for this idiom).
		if (asString(q["format"]) === "jsonld") {
			return c.json(photonToSchemaOrg(collection) as never, 200)
		}

		return c.json(collection, 200)
	})

	app.openapi(reverseRoute, async (c) => {
		if (!engine.reverse) return c.json({ ...EMPTY, message: "reverse not implemented" }, 501)
		const q = legacyQuery(c)
		const lat = Number(q["lat"])
		const lon = Number(q["lon"])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return c.json({ ...EMPTY, message: "lat and lon are required" }, 400)
		}

		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
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

		// #1052: `format=jsonld` re-serializes the reverse FeatureCollection as schema.org `Place[]` JSON-LD. See
		// the search handler's comment above for why this is a local cast, not a wire-behavior change.
		if (asString(q["format"]) === "jsonld") {
			return c.json(photonToSchemaOrg(collection) as never, 200)
		}

		return c.json(collection, 200)
	})
}
