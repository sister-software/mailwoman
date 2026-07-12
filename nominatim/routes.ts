/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route definitions + handlers for the Nominatim-compatible surface. The OpenAPI document is
 *   emitted from these definitions — no handwritten spec. Handlers parse params from the
 *   `legacyQuery` express-shaped view; the zod query schemas drive only the emitted document.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"

import type {
	NominatimEngine,
	NominatimFormat,
	NominatimLookupParams,
	NominatimReverseParams,
	NominatimSearchParams,
	NominatimStatus,
} from "./engine.ts"
import { nominatimResultToSchemaOrg, toFeatureCollection } from "./format.ts"
import {
	ErrorSchema,
	lookupQueryParams,
	NominatimLookupResponseSchema,
	NominatimReverseResponseSchema,
	NominatimSearchResponseSchema,
	NominatimStatusSchema,
	reverseQueryParams,
	searchQueryParams,
} from "./schema.ts"

const DEFAULT_LIMIT = 10

function parseFormat(raw: unknown): NominatimFormat {
	return raw === "geojson" || raw === "json" || raw === "jsonld" ? raw : "jsonv2"
}

function parseBool(raw: unknown): boolean {
	return raw === "1" || raw === "true"
}

function asString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length > 0 ? raw : undefined
}

/**
 * Express's `req.query` shape: `string` for a single value, `string[]` for repeats. The legacy parsing helpers
 * (`asString`, `parseFormat`, `parseBool`, `Number(...)`) — and their observable degenerate behaviors (repeated `q` →
 * `asString(array)` → undefined → silently treated as absent, never a 400) — key off exactly this shape, so the
 * handlers consume it unchanged. Null-prototype, matching express-simple's req.query shape (a repeated `?__proto__=`
 * param must create an own property, not reparent the object).
 */
function legacyQuery(c: Context): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = Object.create(null)

	for (const [key, values] of Object.entries(c.req.queries())) {
		out[key] = values.length === 1 ? values[0]! : values
	}

	return out
}

/**
 * A friendly HTML landing page for `GET /` (#1022). Nominatim itself has no root page (just `/status`), so there's no
 * wire contract to match — this is pure courtesy: a browser visitor who pastes the bare host in gets a one-glance
 * orientation with clickable example queries instead of Express's `Cannot GET /` 404, which reads as "the service is
 * broken". Relative example URLs so they resolve against whatever host/port serves this.
 */
const ROOT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@mailwoman/nominatim</title>
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
<h1>@mailwoman/nominatim</h1>
<p>A Nominatim-compatible geocoding API — the same <code>/search</code>, <code>/reverse</code>, <code>/lookup</code>, and <code>/status</code> contract, served from a SQLite gazetteer instead of a PostgreSQL/PostGIS import.</p>
<p>Try a query:</p>
<ul>
<li><a class="q" href="/search?q=berlin&amp;format=jsonv2&amp;limit=3">/search?q=berlin&amp;format=jsonv2&amp;limit=3</a></li>
<li><a class="q" href="/search?q=1600+pennsylvania+ave+washington+dc&amp;addressdetails=1">/search?q=1600+pennsylvania+ave+washington+dc&amp;addressdetails=1</a></li>
<li><a class="q" href="/reverse?lat=52.52&amp;lon=13.405">/reverse?lat=52.52&amp;lon=13.405</a></li>
</ul>
<footer><a href="https://mailwoman.sister.software/docs/concepts/switching-from-nominatim">Switching from Nominatim</a> &middot; <a href="https://mailwoman.sister.software/demo">Live demo</a></footer>
</body>
</html>
`

const errorContent = (description: string) => ({
	description,
	content: { "application/json": { schema: ErrorSchema } },
})

const searchResponses = {
	200: {
		description: "A jsonv2 result array (or a geojson FeatureCollection / jsonld Place[] per `format`).",
		content: { "application/json": { schema: NominatimSearchResponseSchema } },
	},
	500: errorContent("An unexpected engine fault. A clean JSON error, never a stack trace."),
	501: errorContent("The backing engine method is not wired for this deployment."),
}

const reverseResponses = {
	200: {
		description: "A single jsonv2 result (or `null`; a geojson FeatureCollection / jsonld Place per `format`).",
		content: { "application/json": { schema: NominatimReverseResponseSchema } },
	},
	400: errorContent("Missing or out-of-range `lat`/`lon`."),
	500: errorContent("An unexpected engine fault. A clean JSON error, never a stack trace."),
	501: errorContent("The backing engine method is not wired for this deployment."),
}

const lookupResponses = {
	200: {
		description: "A jsonv2 result array (or a geojson FeatureCollection when format=geojson).",
		content: { "application/json": { schema: NominatimLookupResponseSchema } },
	},
	500: errorContent("An unexpected engine fault. A clean JSON error, never a stack trace."),
	501: errorContent("The backing engine method is not wired for this deployment."),
}

const statusResponses = {
	200: {
		description: 'Engine health. Absent `engine.status` answers `{status: 0, message: "OK"}` — never 501.',
		content: { "application/json": { schema: NominatimStatusSchema } },
	},
	500: errorContent("An unexpected engine fault. A clean JSON error, never a stack trace."),
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
	path: "/search",
	operationId: "search",
	summary: "Forward geocoding (free-text or structured)",
	tags: ["geocoding"],
	request: { query: searchQueryParams },
	responses: searchResponses,
})

const reverseRoute = createRoute({
	method: "get",
	path: "/reverse",
	operationId: "reverse",
	summary: "Reverse geocoding",
	tags: ["geocoding"],
	request: { query: reverseQueryParams },
	responses: reverseResponses,
})

const lookupRoute = createRoute({
	method: "get",
	path: "/lookup",
	operationId: "lookup",
	summary: "Look up places by OSM id",
	tags: ["geocoding"],
	request: { query: lookupQueryParams },
	responses: lookupResponses,
})

const statusRoute = createRoute({
	method: "get",
	path: "/status",
	operationId: "status",
	summary: "Engine health",
	tags: ["meta"],
	responses: statusResponses,
})

/** Register the Nominatim-compatible routes against an injected engine. */
export function registerNominatimRoutes(app: OpenAPIHono, engine: NominatimEngine): void {
	app.openapi(rootRoute, (c) => c.html(ROOT_HTML))

	app.openapi(searchRoute, async (c) => {
		if (!engine.search) return c.json({ error: "search not implemented (see #802)" }, 501)
		const q = legacyQuery(c)
		const params: NominatimSearchParams = {
			q: asString(q["q"]),
			street: asString(q["street"]),
			city: asString(q["city"]),
			county: asString(q["county"]),
			state: asString(q["state"]),
			country: asString(q["country"]),
			postalcode: asString(q["postalcode"]),
			countrycodes: asString(q["countrycodes"])?.split(","),
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			bounded: parseBool(q["bounded"]),
			// #1052: jsonld projects the address breakdown into a PostalAddress, so it needs the details block.
			addressdetails: parseBool(q["addressdetails"]) || q["format"] === "jsonld",
			format: parseFormat(q["format"]),
			acceptLanguage: asString(q["accept-language"]),
		}
		const results = await engine.search(params)

		if (params.format === "geojson") {
			return c.json(toFeatureCollection(results) as never, 200)
		} else if (params.format === "jsonld") {
			// #1052: re-serialize the SAME results as schema.org `Place[]`; jsonv2 stays the default.
			return c.json(results.map(nominatimResultToSchemaOrg) as never, 200)
		}

		return c.json(results as never, 200)
	})

	app.openapi(reverseRoute, async (c) => {
		if (!engine.reverse) return c.json({ error: "reverse not implemented (see #803)" }, 501)
		const q = legacyQuery(c)
		const lat = Number(q["lat"])
		const lon = Number(q["lon"])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return c.json({ error: "lat and lon are required" }, 400)
		}

		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			return c.json({ error: "lat must be in [-90, 90] and lon in [-180, 180]" }, 400)
		}
		const params: NominatimReverseParams = {
			lat,
			lon,
			zoom: q["zoom"] != null ? Number(q["zoom"]) : undefined,
			// #1052: jsonld projects the address breakdown into a PostalAddress, so it needs the details block.
			addressdetails: parseBool(q["addressdetails"]) || q["format"] === "jsonld",
			format: parseFormat(q["format"]),
			acceptLanguage: asString(q["accept-language"]),
		}
		const result = await engine.reverse(params)

		if (params.format === "geojson") {
			return c.json(toFeatureCollection(result ? [result] : []) as never, 200)
		} else if (params.format === "jsonld") {
			// #1052: a single reverse hit → one schema.org `Place` (or null when unresolved).
			return c.json((result ? nominatimResultToSchemaOrg(result) : null) as never, 200)
		}

		return c.json(result as never, 200)
	})

	app.openapi(lookupRoute, async (c) => {
		if (!engine.lookup) return c.json({ error: "lookup not implemented (see #805)" }, 501)
		const q = legacyQuery(c)
		const params: NominatimLookupParams = {
			osmIds: asString(q["osm_ids"])?.split(",") ?? [],
			addressdetails: parseBool(q["addressdetails"]),
			format: parseFormat(q["format"]),
		}
		const results = await engine.lookup(params)

		// NOTE: no jsonld branch here — a legacy quirk of the express handler, preserved verbatim. `format=jsonld`
		// on `/lookup` falls through to the raw jsonv2 results, unlike `/search` and `/reverse`.
		return c.json((params.format === "geojson" ? toFeatureCollection(results) : results) as never, 200)
	})

	app.openapi(statusRoute, async (c) => {
		if (!engine.status) return c.json({ status: 0, message: "OK" } satisfies NominatimStatus, 200)

		return c.json(await engine.status(), 200)
	})
}
