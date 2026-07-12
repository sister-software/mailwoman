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

import { type LibpostalEngine, toLibpostalComponents } from "./engine.ts"

export * from "./engine.ts"
export * from "./schema.ts"

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

/**
 * A friendly HTML landing page for `GET /` (#1022). libpostal's own REST server has no root page, so there's no wire
 * contract to match — this is pure courtesy: a browser visitor who pastes the bare host in gets a one-glance
 * orientation with clickable example queries instead of Express's `Cannot GET /` 404, which reads as "the service is
 * broken". Relative example URLs so they resolve against whatever host/port serves this.
 */
const ROOT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@mailwoman/libpostal</title>
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
<h1>@mailwoman/libpostal</h1>
<p>A libpostal-compatible <code>/parse</code> and <code>/expand</code> API, backed by a calibrated neural address parser (<code>POST</code> a JSON body, or <code>GET</code> with a query param).</p>
<p>Try a query:</p>
<ul>
<li><a class="q" href="/parse?query=1600+pennsylvania+ave+washington+dc">/parse?query=1600+pennsylvania+ave+washington+dc</a></li>
<li><a class="q" href="/parse?query=berlin+germany">/parse?query=berlin+germany</a></li>
<li><a class="q" href="/expand?address=1600+pennsylvania+ave+nw">/expand?address=1600+pennsylvania+ave+nw</a></li>
</ul>
<footer><a href="https://mailwoman.sister.software/docs/concepts/switching-from-libpostal">Switching from libpostal</a> &middot; <a href="https://mailwoman.sister.software/demo">Live demo</a></footer>
</body>
</html>
`

/** Build the libpostal-compatible router around an injected {@link LibpostalEngine}. */
export function createLibpostalRouter(engine: LibpostalEngine, options: LibpostalRouterOptions = {}): Router {
	const router = Router()

	// Browser clients need CORS or their cross-origin XHR is blocked before completing (#1017).
	if (options.cors !== false) {
		router.use(applyCors)
	}

	// A helpful root banner instead of a bare `Cannot GET /` 404 — the first thing a browser visitor hits (#1022).
	const root: RequestHandler = (_req, res) => {
		res.type("html").send(ROOT_HTML)
	}

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
				if (!res.headersSent) {
					res.status(500).json({ error: "internal error" })
				}
			}
		}

	router.get("/", safe(root))
	router.post("/parse", safe(parse))
	router.get("/parse", safe(parse))
	router.post("/expand", safe(expand))
	router.get("/expand", safe(expand))

	return router
}
