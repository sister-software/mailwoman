/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/photon` — a Photon-compatible autocomplete / type-ahead geocoding API over the
 *   Mailwoman engine. Where `@mailwoman/nominatim` is structured lookup, Photon is
 *   search-as-you-type: a GeoJSON `FeatureCollection` per query, biased by location, ranked for
 *   prefixes. It maps onto Mailwoman's shipped FST autocomplete tier (#190/#587) + parse →
 *   resolve.
 *
 *   Like its sibling, the package is engine-agnostic: {@link createPhotonRouter} takes a
 *   {@link PhotonEngine}; the CLI wires the real engine. Implementation is staged on the epic (#801
 *   / the Photon child); routes whose engine method is absent answer `501`.
 *
 *   Wire types + the engine contract live in `engine.ts`; the resolved-place → Photon-schema
 *   projection lives in `projection.ts`; the zod wire schemas live in `schema.ts`.
 */

import { type RequestHandler, Router } from "express"

import type { PhotonEngine, PhotonFeatureCollection, PhotonReverseParams, PhotonSearchParams } from "./engine.ts"
import { photonToSchemaOrg } from "./projection.ts"

export * from "./engine.ts"
export * from "./projection.ts"
export * from "./schema.ts"

const DEFAULT_LIMIT = 15

function asString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length > 0 ? raw : undefined
}

function asStringArray(raw: unknown): string[] | undefined {
	if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string")
	const s = asString(raw)

	return s ? [s] : undefined
}

const EMPTY: PhotonFeatureCollection = { type: "FeatureCollection", features: [] }

/** Options for {@link createPhotonRouter}. */
export interface PhotonRouterOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — upstream komoot/photon serves permissive CORS, and the map-widget use case
	 * (leaflet-control-geocoder, @openrunner/photon-geocoder, …) needs it: a browser's cross-origin XHR is blocked
	 * without it (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean
}

/**
 * Permissive CORS, matching upstream Photon: `Access-Control-Allow-Origin: *` on every response, plus a `204` answer to
 * preflight `OPTIONS`. `ACAO: *` is anonymous (no credentials), so a wildcard `Allow-Headers` is valid.
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

/**
 * Build the Photon-compatible router around an injected {@link PhotonEngine}. Param parsing lives here; the feature
 * _projection_ (resolved place → {@link PhotonProperties}) is the staged work.
 */
export function createPhotonRouter(engine: PhotonEngine, options: PhotonRouterOptions = {}): Router {
	const router = Router()

	// Browser-embedded widgets need CORS or their cross-origin XHR is blocked before the request completes (#1017).
	if (options.cors !== false) {
		router.use(applyCors)
	}

	// A helpful root banner instead of a bare `Cannot GET /` 404 — the first thing a browser visitor hits (#1022).
	const root: RequestHandler = (_req, res) => {
		res.type("html").send(ROOT_HTML)
	}

	const search: RequestHandler = async (req, res) => {
		if (!engine.search) {
			res.status(501).json({ ...EMPTY, message: "search not implemented" })

			return
		}
		const q = req.query
		const query = asString(q["q"])

		if (!query) {
			res.status(400).json({ ...EMPTY, message: "q is required" })

			return
		}
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
		// #1052: `format=jsonld` re-serializes the SAME FeatureCollection as schema.org `Place[]` JSON-LD;
		// the native GeoJSON FeatureCollection stays the default.
		res.json(asString(q["format"]) === "jsonld" ? photonToSchemaOrg(collection) : collection)
	}

	const reverse: RequestHandler = async (req, res) => {
		if (!engine.reverse) {
			res.status(501).json({ ...EMPTY, message: "reverse not implemented" })

			return
		}
		const q = req.query
		const lat = Number(q["lat"])
		const lon = Number(q["lon"])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			res.status(400).json({ ...EMPTY, message: "lat and lon are required" })

			return
		}

		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
			res.status(400).json({ ...EMPTY, message: "lat must be in [-90, 90] and lon in [-180, 180]" })

			return
		}
		const params: PhotonReverseParams = {
			lat,
			lon,
			limit: Number(q["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
			lang: asString(q["lang"]),
			radius: q["radius"] != null ? Number(q["radius"]) : undefined,
		}
		const collection = await engine.reverse(params)
		// #1052: `format=jsonld` re-serializes the reverse FeatureCollection as schema.org `Place[]` JSON-LD.
		res.json(asString(q["format"]) === "jsonld" ? photonToSchemaOrg(collection) : collection)
	}

	// Safety net: malformed input or an engine fault returns an empty FeatureCollection, never a crash.
	const safe =
		(fn: RequestHandler): RequestHandler =>
		async (req, res, next) => {
			try {
				await fn(req, res, next)
			} catch {
				if (!res.headersSent) {
					res.status(500).json({ ...EMPTY, message: "internal error" })
				}
			}
		}

	router.get("/", safe(root))
	router.get("/api", safe(search))
	router.get("/reverse", safe(reverse))

	return router
}
