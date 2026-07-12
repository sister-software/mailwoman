/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route definitions + handlers for the libpostal-compatible surface. The OpenAPI document is
 *   emitted from these definitions — there is no handwritten spec. Wire shapes (bodies, error
 *   envelopes, status codes) are the vendor contract; see schema.ts.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context, MiddlewareHandler } from "hono"

import { type LibpostalEngine, toLibpostalComponents } from "./engine.ts"
import {
	ErrorSchema,
	ExpandRequestSchema,
	ExpandResponseSchema,
	ParseRequestSchema,
	ParseResponseSchema,
} from "./schema.ts"

/**
 * A friendly HTML landing page for `GET /` (#1022). libpostal's own REST server has no root page, so there's no wire
 * contract to match — pure courtesy for browser visitors. Relative example URLs so they resolve against whatever
 * host/port serves this.
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

const errorContent = (description: string) => ({
	description,
	content: { "application/json": { schema: ErrorSchema } },
})

/** Query-side request schema, shared by the GET routes (documented; presence enforced in-handler). */
const parseQueryParams = z.object({
	query: z.string().optional().openapi({ description: "The address to parse. `address` is accepted as an alias." }),
	address: z.string().optional().openapi({ description: "Alias for `query`." }),
})

const expandQueryParams = z.object({
	address: z.string().optional().openapi({ description: "The address to expand." }),
})

const parseResponses = {
	200: {
		description: "The ordered libpostal components.",
		content: { "application/json": { schema: ParseResponseSchema } },
	},
	400: errorContent("The required `query` (or `address`) parameter is missing."),
	500: errorContent("An unexpected engine fault. A clean JSON error, never a stack trace."),
}

const expandResponses = {
	200: {
		description: "The deterministic expansion set.",
		content: { "application/json": { schema: ExpandResponseSchema } },
	},
	400: errorContent("The required `address` parameter is missing."),
	500: errorContent("An unexpected engine fault. A clean JSON error, never a stack trace."),
	501: errorContent("The backing engine method is not wired for this deployment."),
}

const rootRoute = createRoute({
	method: "get",
	path: "/",
	operationId: "getRoot",
	summary: "Landing page",
	tags: ["meta"],
	responses: {
		200: { description: "HTML landing page.", content: { "text/html": { schema: z.string() } } },
	},
})

const parseGetRoute = createRoute({
	method: "get",
	path: "/parse",
	operationId: "parseGet",
	summary: "Parse an address (query string)",
	tags: ["parsing"],
	request: { query: parseQueryParams },
	responses: parseResponses,
})

const parsePostRoute = createRoute({
	method: "post",
	path: "/parse",
	operationId: "parsePost",
	summary: "Parse an address (JSON body)",
	tags: ["parsing"],
	request: {
		body: { content: { "application/json": { schema: ParseRequestSchema } }, required: false },
	},
	responses: parseResponses,
})

const expandGetRoute = createRoute({
	method: "get",
	path: "/expand",
	operationId: "expandGet",
	summary: "Expand an address (query string)",
	tags: ["parsing"],
	request: { query: expandQueryParams },
	responses: expandResponses,
})

const expandPostRoute = createRoute({
	method: "post",
	path: "/expand",
	operationId: "expandPost",
	summary: "Expand an address (JSON body)",
	tags: ["parsing"],
	request: {
		body: { content: { "application/json": { schema: ExpandRequestSchema } }, required: false },
	},
	responses: expandResponses,
})

/** Read the JSON body if present and parseable; a missing/malformed body is `{}` (legacy tolerance). */
async function readBody(c: Context): Promise<Record<string, unknown>> {
	try {
		const body = (await c.req.json()) as unknown

		return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

/**
 * Coalesce candidate params by raw presence, not truthiness — an empty-but-present string must survive coalescing so it
 * wins precedence over a lower-priority param (legacy wire parity: the old handler trimmed AFTER coalescing).
 */
const rawParam = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/**
 * The zod-openapi auto body validator runs before the handlers and would reject or throw on request shapes the legacy
 * endpoint tolerated (malformed JSON, non-JSON content types, non-string fields, bodyless POSTs). Canonicalize every
 * POST body into well-formed JSON carrying only the string-typed contract fields, so validation can never fail and
 * every wire decision stays in the handlers.
 */
const canonicalizeJSONBody: MiddlewareHandler = async (c, next) => {
	if (c.req.method === "POST") {
		let fields: Record<string, string> = {}

		try {
			const raw = c.req.raw.body ? await c.req.raw.text() : ""
			const parsed = raw ? (JSON.parse(raw) as unknown) : {}

			if (typeof parsed === "object" && parsed !== null) {
				for (const key of ["query", "address"] as const) {
					const value = (parsed as Record<string, unknown>)[key]

					if (typeof value === "string") {
						fields[key] = value
					}
				}
			}
		} catch {
			fields = {}
		}

		const headers = new Headers(c.req.raw.headers)
		headers.delete("content-length")
		headers.set("content-type", "application/json")

		c.req.raw = new Request(c.req.raw.url, {
			method: "POST",
			headers,
			body: JSON.stringify(fields),
		})
	}

	await next()
}

/**
 * The zod-openapi auto query validator rejects array-valued repeated params (`?query=a&query=b`) with its own error
 * shape before the handlers run. Keep only the first value of each contract param — the value `c.req.query()` reads
 * anyway — so query validation can never fail either.
 */
const canonicalizeQueryParams: MiddlewareHandler = async (c, next) => {
	if (c.req.method === "GET") {
		const url = new URL(c.req.raw.url)

		for (const key of ["query", "address"] as const) {
			const values = url.searchParams.getAll(key)

			if (values.length > 1) {
				url.searchParams.delete(key)
				url.searchParams.set(key, values[0]!)
			}
		}

		if (url.toString() !== c.req.raw.url) {
			c.req.raw = new Request(url, c.req.raw)
		}
	}

	await next()
}

/** Register the libpostal-compatible routes against an injected engine. */
export function registerLibpostalRoutes(app: OpenAPIHono, engine: LibpostalEngine): void {
	app.use("/parse", canonicalizeJSONBody)
	app.use("/expand", canonicalizeJSONBody)
	app.use("/parse", canonicalizeQueryParams)
	app.use("/expand", canonicalizeQueryParams)

	app.openapi(rootRoute, (c) => c.html(ROOT_HTML))

	const parse = async (c: Context, body: Record<string, unknown>) => {
		const query = (
			rawParam(body.query) ??
			rawParam(c.req.query("query")) ??
			rawParam(body.address) ??
			rawParam(c.req.query("address"))
		)?.trim()

		if (!query) return c.json({ error: "query is required" }, 400)

		return c.json(toLibpostalComponents(await engine.parse(query)), 200)
	}

	const expand = async (c: Context, body: Record<string, unknown>) => {
		if (!engine.expand) return c.json({ error: "expand not implemented" }, 501)

		const address = (rawParam(body.address) ?? rawParam(c.req.query("address")))?.trim()

		if (!address) return c.json({ error: "address is required" }, 400)

		return c.json({ expansions: await engine.expand(address) }, 200)
	}

	app.openapi(parseGetRoute, (c) => parse(c, {}))
	app.openapi(parsePostRoute, async (c) => parse(c, await readBody(c)))
	app.openapi(expandGetRoute, (c) => expand(c, {}))
	app.openapi(expandPostRoute, async (c) => expand(c, await readBody(c)))
}
