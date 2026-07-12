/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/nominatim` — a Nominatim-compatible HTTP geocoding API over the Mailwoman engine.
 *
 *   The package is intentionally engine-agnostic: {@link createNominatimRouter} takes a
 *   {@link NominatimEngine} (the thing that actually parses + resolves) and exposes it under the
 *   endpoint shapes + response format a Nominatim client expects. The CLI (`./cli.ts`) wires the
 *   real Mailwoman engine; tests can inject a fake. This keeps the compat surface isolated from the
 *   resolver wiring.
 *
 *   Implementation is staged across the epic (#801): #804 the result formatter, #802 `/search`, #803
 *   `/reverse`, #805 `/lookup` + `/status`. Routes whose engine method is absent answer `501`.
 *
 *   Wire types + the engine contract live in `engine.ts`; the RESOLVED-address → Nominatim-schema
 *   formatter lives in `format.ts`; the zod wire schemas live in `schema.ts`.
 */

import { type RequestHandler, Router } from "express"

import type {
	NominatimEngine,
	NominatimFormat,
	NominatimLookupParams,
	NominatimReverseParams,
	NominatimSearchParams,
	NominatimStatus,
} from "./engine.ts"
import { nominatimResultToSchemaOrg, toFeatureCollection } from "./format.ts"

export * from "./engine.ts"
export * from "./format.ts"
export * from "./schema.ts"

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

/** Options for {@link createNominatimRouter}. */
export interface NominatimRouterOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — browser-embedded geocoder clients need it: a cross-origin XHR is blocked without it
	 * (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean
}

/**
 * Permissive CORS: `Access-Control-Allow-Origin: *` on every response, plus a `204` answer to preflight `OPTIONS`.
 * `ACAO: *` is anonymous (no credentials), so a wildcard `Allow-Headers` is valid.
 */
const applyCors: RequestHandler = (req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
	res.setHeader("Access-Control-Allow-Headers", "*")

	if (req.method === "OPTIONS") {
		res.setHeader("Access-Control-Max-Age", "86400")
		res.status(204).end()

		return
	}
	next()
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

/**
 * Build the Nominatim-compatible router around an injected {@link NominatimEngine}. Query-param parsing lives here; the
 * result _formatting_ (jsonv2 vs geojson envelope, `address` projection) is #804 and currently passes the engine's
 * results through verbatim.
 */
export function createNominatimRouter(engine: NominatimEngine, options: NominatimRouterOptions = {}): Router {
	const router = Router()

	// Browser-embedded geocoder clients need CORS or their cross-origin XHR is blocked before completing (#1017).
	if (options.cors !== false) {
		router.use(applyCors)
	}

	// A helpful root banner instead of a bare `Cannot GET /` 404 — the first thing a browser visitor hits (#1022).
	const root: RequestHandler = (_req, res) => {
		res.type("html").send(ROOT_HTML)
	}

	const search: RequestHandler = async (req, res) => {
		if (!engine.search) {
			res.status(501).json({ error: "search not implemented (see #802)" })

			return
		}
		const q = req.query
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
			res.json(toFeatureCollection(results))
		} else if (params.format === "jsonld") {
			// #1052: re-serialize the SAME results as schema.org `Place[]`; jsonv2 stays the default.
			res.json(results.map(nominatimResultToSchemaOrg))
		} else {
			res.json(results)
		}
	}

	const reverse: RequestHandler = async (req, res) => {
		if (!engine.reverse) {
			res.status(501).json({ error: "reverse not implemented (see #803)" })

			return
		}
		const q = req.query
		const lat = Number(q["lat"])
		const lon = Number(q["lon"])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			res.status(400).json({ error: "lat and lon are required" })

			return
		}

		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			res.status(400).json({ error: "lat must be in [-90, 90] and lon in [-180, 180]" })

			return
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
			res.json(toFeatureCollection(result ? [result] : []))
		} else if (params.format === "jsonld") {
			// #1052: a single reverse hit → one schema.org `Place` (or null when unresolved).
			res.json(result ? nominatimResultToSchemaOrg(result) : null)
		} else {
			res.json(result)
		}
	}

	const lookup: RequestHandler = async (req, res) => {
		if (!engine.lookup) {
			res.status(501).json({ error: "lookup not implemented (see #805)" })

			return
		}
		const params: NominatimLookupParams = {
			osmIds: asString(req.query["osm_ids"])?.split(",") ?? [],
			addressdetails: parseBool(req.query["addressdetails"]),
			format: parseFormat(req.query["format"]),
		}
		const results = await engine.lookup(params)
		res.json(params.format === "geojson" ? toFeatureCollection(results) : results)
	}

	const status: RequestHandler = async (_req, res) => {
		if (!engine.status) {
			res.json({ status: 0, message: "OK" } satisfies NominatimStatus)

			return
		}
		res.json(await engine.status())
	}

	// Safety net: a malformed query (whitespace-only, absurdly long, control chars) or an engine fault
	// must never crash the process into a stack-trace 500. Wrap every handler so an unexpected throw
	// becomes a clean JSON error.
	const safe =
		(fn: RequestHandler): RequestHandler =>
		async (req, res, next) => {
			try {
				await fn(req, res, next)
			} catch {
				if (!res.headersSent) {
					res.status(500).json({ error: "internal error" })
				}
			}
		}

	router.get("/", safe(root))
	router.get("/search", safe(search))
	router.get("/reverse", safe(reverse))
	router.get("/lookup", safe(lookup))
	router.get("/status", safe(status))

	return router
}
