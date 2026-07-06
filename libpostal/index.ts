/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/libpostal` — a libpostal-compatible parse/expand HTTP API over Mailwoman's neural
 *   address parser. The lowest-dependency drop-in: `/parse` is a serializer over the BIO tagger's
 *   labeled spans, no gazetteer or resolver needed.
 *
 *   Engine-agnostic, like the nominatim/photon packages: {@link createLibpostalRouter} takes a
 *   {@link LibpostalEngine}; the CLI wires the real parser. The classification → libpostal-label
 *   mapping lives here (it is libpostal-specific knowledge), so the engine yields raw Mailwoman
 *   matches.
 */

import { type RequestHandler, Router } from "express"

/** A libpostal `parse_address` component: a label + the text it covers, in order. */
export interface LibpostalComponent {
	label: string
	value: string
}

/** A raw Mailwoman match the engine yields (our `ComponentTag` classification + the covered text). */
export interface ParseMatch {
	classification: string
	value: string
}

/**
 * Mailwoman `ComponentTag` → libpostal label. libpostal's label set is OSM-derived; ours is close but not identical, so
 * map the overlap and pass unmapped classifications through unchanged.
 */
export const COMPONENT_TO_LIBPOSTAL: Record<string, string> = {
	house_number: "house_number",
	street: "road",
	venue: "house",
	house: "house",
	unit: "unit",
	level: "level",
	po_box: "po_box",
	postcode: "postcode",
	locality: "city",
	dependent_locality: "suburb",
	neighbourhood: "suburb",
	borough: "city_district",
	region: "state",
	macroregion: "state_district",
	country: "country",
	country_region: "country_region",
	world_region: "world_region",
}

/** Map raw Mailwoman matches to libpostal's ordered `[{label, value}]` shape. */
export function toLibpostalComponents(matches: ParseMatch[]): LibpostalComponent[] {
	return matches.map((m) => ({ label: COMPONENT_TO_LIBPOSTAL[m.classification] ?? m.classification, value: m.value }))
}

/**
 * The parsing engine the router delegates to. `parse` is required; `expand` is optional (a missing one answers `501`).
 * The CLI wires `parse` to Mailwoman's `createAddressParser` and `expand` to `@mailwoman/normalize`.
 */
export interface LibpostalEngine {
	parse(query: string): Promise<ParseMatch[]>
	expand?(address: string): Promise<string[]>
}

/** Options for {@link createLibpostalRouter}. */
export interface LibpostalRouterOptions {
	/**
	 * Emit permissive CORS headers (`Access-Control-Allow-Origin: *`) on every response and answer preflight `OPTIONS`
	 * with `204`. Default `true` — browser clients need it: a cross-origin XHR (including the `POST /parse` preflight) is
	 * blocked without it (#1017). Set `false` when a reverse proxy already owns the CORS headers.
	 */
	cors?: boolean
}

/**
 * Permissive CORS: `Access-Control-Allow-Origin: *` on every response, plus a `204` answer to preflight `OPTIONS`.
 * `POST /parse` is a preflighted CORS request, so the `OPTIONS` answer must advertise `POST`. `ACAO: *` is anonymous
 * (no credentials), so a wildcard `Allow-Headers` is valid.
 */
const applyCors: RequestHandler = (req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	res.setHeader("Access-Control-Allow-Headers", "*")

	if (req.method === "OPTIONS") {
		res.setHeader("Access-Control-Max-Age", "86400")
		res.status(204).end()

		return
	}
	next()
}

/** Build the libpostal-compatible router around an injected {@link LibpostalEngine}. */
export function createLibpostalRouter(engine: LibpostalEngine, options: LibpostalRouterOptions = {}): Router {
	const router = Router()

	// Browser clients need CORS or their cross-origin XHR is blocked before completing (#1017).
	if (options.cors !== false) router.use(applyCors)

	const parse: RequestHandler = async (req, res) => {
		const query = (
			(req.body?.query ?? req.query?.query ?? req.body?.address ?? req.query?.address) as string | undefined
		)?.trim()

		if (!query) {
			res.status(400).json({ error: "query is required" })

			return
		}
		res.json(toLibpostalComponents(await engine.parse(query)))
	}

	const expand: RequestHandler = async (req, res) => {
		if (!engine.expand) {
			res.status(501).json({ error: "expand not implemented" })

			return
		}
		const address = ((req.body?.address ?? req.query?.address) as string | undefined)?.trim()

		if (!address) {
			res.status(400).json({ error: "address is required" })

			return
		}
		res.json({ expansions: await engine.expand(address) })
	}

	// Safety net: a malformed body or an engine fault returns a clean JSON error, never a crash.
	const safe =
		(fn: RequestHandler): RequestHandler =>
		async (req, res, next) => {
			try {
				await fn(req, res, next)
			} catch {
				if (!res.headersSent) res.status(500).json({ error: "internal error" })
			}
		}

	router.post("/parse", safe(parse))
	router.get("/parse", safe(parse))
	router.post("/expand", safe(expand))
	router.get("/expand", safe(expand))

	return router
}
