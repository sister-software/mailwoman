/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route definitions + handlers for the native `/v1` surface. The OpenAPI document is emitted from
 *   these definitions — there is no handwritten spec. Unlike the drop-ins (photon, nominatim,
 *   libpostal), nothing here mimics a vendor's legacy query-parsing tolerance: request bodies are
 *   validator-enforced, and a validation failure always answers through the shared api-kit envelope
 *   (`apiError`), never the raw zod shape. `GET /v1/parse` is the one query-string route, and it
 *   reads `c.req.query()` directly — a query string has no repeated-value contract worth preserving
 *   here (contrast the drop-ins' `legacyQuery` adapter), so there's nothing to tolerate.
 *
 *   Per-route validation hooks (the 3rd arg to `app.openapi(route, handler, hook)`) override the
 *   app-level `defaultHook` (wired in `app.ts`) so each route can answer its OWN friendly business
 *   message — `"address is required"`, `"body must be { addresses: string[] }"`, etc. — matching the
 *   express `mailwoman/server` precedent this surface carries forward. Routes with no friendly
 *   carry-forward message (currently just `/v1/format`) fall through to the app-level hook's generic
 *   `"invalid request body"`.
 */

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi"
import { metricsSnapshot, recordTimed } from "@mailwoman/api-kit"
import type { AddressTree } from "@mailwoman/core/decoder"
import type { ComponentTag } from "@mailwoman/core/types"
import { canonicalKey, type ComponentDict, formatAddress, type FormatAddressOptions } from "@mailwoman/formatter"

import type { MailwomanAPIEngine } from "./engine.ts"
import {
	APIErrorSchema,
	BatchRequestSchema,
	BatchResponseSchema,
	FormatRequestSchema,
	FormatResponseSchema,
	GeocodeOutcomeSchema,
	GeocodeRequestSchema,
	HealthResponseSchema,
	ParseOutcomeSchema,
	ParseRequestSchema,
	ResolveRequestSchema,
	ResolveResponseSchema,
} from "./schema.ts"

/**
 * Default `POST /v1/batch` row cap when {@link RegisterMailwomanAPIRoutesOptions.batchMax} is omitted. This is the
 * standalone-engine default, not derived from env — `mailwoman serve` always passes the env-derived value explicitly
 * (`$public.MAILWOMAN_BATCH_MAX`, default 1000; see `core/env/schema.ts`).
 */
export const DEFAULT_BATCH_MAX = 500

const startedAt = Date.now()

/** Options for {@link registerMailwomanAPIRoutes}. */
export interface RegisterMailwomanAPIRoutesOptions {
	/** Max `addresses` rows accepted by `POST /v1/batch`. Default {@link DEFAULT_BATCH_MAX}. */
	batchMax?: number
}

const errorContent = (description: string) => ({
	description,
	content: { "application/json": { schema: APIErrorSchema } },
})

const parseQueryParams = z.object({
	address: z.string().optional().openapi({ description: "The address to parse." }),
	debug: z.string().optional().openapi({ description: '`"true"` to include a diagnostic report.' }),
})

const parseResponses = {
	200: {
		description: "The tokenized input span + ranked solutions.",
		content: { "application/json": { schema: ParseOutcomeSchema } },
	},
	400: errorContent("`address` is required."),
	501: errorContent("The backing engine method is not wired for this deployment."),
}

const geocodeResponses = {
	200: {
		description: "One geocode result (parse → resolve cascade), passed through from the engine verbatim.",
		content: { "application/json": { schema: GeocodeOutcomeSchema } },
	},
	400: errorContent("`address` is required."),
	503: errorContent("The geocoding engine is not wired for this deployment (dependencies missing)."),
}

const batchResponses = {
	200: {
		description: "One result per input address, in input order (per-row error isolation).",
		content: { "application/json": { schema: BatchResponseSchema } },
	},
	400: errorContent("Body must be `{ addresses: string[] }`."),
	413: errorContent("`addresses.length` exceeds the configured batch cap."),
	503: errorContent("The geocoding engine is not wired for this deployment (dependencies missing)."),
}

const resolveResponses = {
	200: {
		description: "The same tree, decorated in place with gazetteer coordinates + attribution.",
		content: { "application/json": { schema: ResolveResponseSchema } },
	},
	400: errorContent("Body must be `{ tree: AddressTree, opts? }`."),
	503: errorContent("The resolver is not wired for this deployment (dependencies missing)."),
}

const reloadResponses = {
	200: {
		description: "Versioned data switchover result — the new per-shard version map.",
		content: {
			"application/json": { schema: z.looseObject({ reloaded: z.boolean(), versions: z.unknown() }) },
		},
	},
	503: errorContent("The geocoding engine is not wired for this deployment (dependencies missing)."),
}

const formatResponses = {
	200: {
		description: "The rendered address string + the deterministic canonical match key.",
		content: { "application/json": { schema: FormatResponseSchema } },
	},
	400: errorContent("Invalid request body."),
}

const healthResponses = {
	200: {
		description: "Liveness + engine health block. Answers 200 even when the engine is absent or broken.",
		content: { "application/json": { schema: HealthResponseSchema } },
	},
}

const metricsResponses = {
	200: {
		description: "The live in-process timing metrics snapshot (latency percentiles + per-tier counts).",
		content: { "application/json": { schema: z.looseObject({}) } },
	},
}

const parseGetRoute = createRoute({
	method: "get",
	path: "/v1/parse",
	operationId: "parseGet",
	summary: "Parse an address (query string)",
	tags: ["parsing"],
	request: { query: parseQueryParams },
	responses: parseResponses,
})

const parsePostRoute = createRoute({
	method: "post",
	path: "/v1/parse",
	operationId: "parsePost",
	summary: "Parse an address (JSON body)",
	tags: ["parsing"],
	request: { body: { content: { "application/json": { schema: ParseRequestSchema } }, required: true } },
	responses: parseResponses,
})

const geocodeRoute = createRoute({
	method: "post",
	path: "/v1/geocode",
	operationId: "geocode",
	summary: "Geocode an address to coordinates",
	tags: ["geocoding"],
	request: { body: { content: { "application/json": { schema: GeocodeRequestSchema } }, required: true } },
	responses: geocodeResponses,
})

const batchRoute = createRoute({
	method: "post",
	path: "/v1/batch",
	operationId: "batch",
	summary: "Geocode a batch of addresses",
	tags: ["geocoding"],
	request: { body: { content: { "application/json": { schema: BatchRequestSchema } }, required: true } },
	responses: batchResponses,
})

const resolveRoute = createRoute({
	method: "post",
	path: "/v1/resolve",
	operationId: "resolve",
	summary: "Resolve an already-decoded address tree against the gazetteer",
	tags: ["resolving"],
	request: { body: { content: { "application/json": { schema: ResolveRequestSchema } }, required: true } },
	responses: resolveResponses,
})

const reloadRoute = createRoute({
	method: "post",
	path: "/v1/reload",
	operationId: "reload",
	summary: "Reload versioned data shards (deploy-only; gate at ingress)",
	tags: ["meta"],
	responses: reloadResponses,
})

const formatRoute = createRoute({
	method: "post",
	path: "/v1/format",
	operationId: "format",
	summary: "Render address components to a string + canonical match key",
	tags: ["formatting"],
	request: { body: { content: { "application/json": { schema: FormatRequestSchema } }, required: true } },
	responses: formatResponses,
})

const healthRoute = createRoute({
	method: "get",
	path: "/health",
	operationId: "health",
	summary: "Liveness + engine health",
	tags: ["meta"],
	responses: healthResponses,
})

const metricsRoute = createRoute({
	method: "get",
	path: "/metrics",
	operationId: "metrics",
	summary: "In-process timing metrics snapshot",
	tags: ["meta"],
	responses: metricsResponses,
})

/**
 * `components` accepts `string | string[]` per key on the wire (a caller may pass every span a multi-span match
 * covered); `formatAddress`/`canonicalKey` want a single string per `ComponentTag`. Multi-span values collapse to their
 * FIRST span here — the formatter template owns joining semantics, not this route.
 */
function toComponentDict(components: Record<string, string | string[]>): ComponentDict {
	const out: ComponentDict = {}

	for (const [key, value] of Object.entries(components)) {
		const first = Array.isArray(value) ? value[0] : value

		if (first !== undefined) {
			out[key as ComponentTag] = first
		}
	}

	return out
}

/** Register the native `/v1` routes + `/health` + `/metrics` against an injected engine. */
export function registerMailwomanAPIRoutes(
	app: OpenAPIHono,
	engine: MailwomanAPIEngine,
	options: RegisterMailwomanAPIRoutesOptions = {}
): void {
	const batchMax = options.batchMax ?? DEFAULT_BATCH_MAX

	app.openapi(parseGetRoute, async (c) => {
		if (!engine.parse) return c.json({ error: "parse not implemented" }, 501)
		const address = c.req.query("address")?.trim()

		if (!address) return c.json({ error: "address is required" }, 400)
		const debug = c.req.query("debug") === "true"
		const outcome = await engine.parse(address, { debug })

		return c.json(outcome, 200)
	})

	app.openapi(
		parsePostRoute,
		async (c) => {
			if (!engine.parse) return c.json({ error: "parse not implemented" }, 501)
			const { address, debug } = c.req.valid("json")
			const trimmed = address.trim()

			if (!trimmed) return c.json({ error: "address is required" }, 400)
			const outcome = await engine.parse(trimmed, { debug: debug ?? false })

			return c.json(outcome, 200)
		},
		(result, c) => {
			if (!result.success) return c.json({ error: "address is required" }, 400)

			return undefined
		}
	)

	app.openapi(
		geocodeRoute,
		async (c) => {
			if (!engine.geocode) return c.json({ error: "geocoder not available" }, 503)
			const { address } = c.req.valid("json")
			const trimmed = address.trim()

			if (!trimmed) return c.json({ error: "address is required" }, 400)
			const t0 = performance.now()

			try {
				const outcome = await engine.geocode(trimmed)
				recordTimed(performance.now() - t0, String(outcome["resolution_tier"] ?? "admin"))

				return c.json(outcome, 200)
			} catch (error) {
				recordTimed(performance.now() - t0, "error")
				throw error
			}
		},
		(result, c) => {
			if (!result.success) return c.json({ error: "address is required" }, 400)

			return undefined
		}
	)

	app.openapi(
		batchRoute,
		async (c) => {
			const { addresses } = c.req.valid("json")

			if (addresses.length === 0) return c.json({ results: [] }, 200)

			if (addresses.length > batchMax) {
				return c.json({ error: `batch too large: ${addresses.length} > ${batchMax}` }, 413)
			}

			if (!engine.batch) return c.json({ error: "geocoder not available" }, 503)

			// Whole-call latency, recorded under the "batch" tier. Per-row tier metrics are the ENGINE's
			// responsibility (phase 4b) — this app only times the call as a unit.
			const t0 = performance.now()

			try {
				const outcome = await engine.batch(addresses)
				recordTimed(performance.now() - t0, "batch")

				return c.json(outcome, 200)
			} catch (error) {
				recordTimed(performance.now() - t0, "error")
				throw error
			}
		},
		(result, c) => {
			if (!result.success) return c.json({ error: "body must be { addresses: string[] }" }, 400)

			return undefined
		}
	)

	app.openapi(
		resolveRoute,
		// Metrics are the ENGINE's responsibility here (phase 4b): the express predecessor recorded the
		// street node's stamped resolution tier per call — the wired engine must carry that over, and
		// must trim batch rows the same way (the route passes raw input through).
		async (c) => {
			if (!engine.resolveTree) return c.json({ error: "resolver not available" }, 503)
			const { tree, opts } = c.req.valid("json")
			// The wire schema keeps `tree` loose (`{ roots: unknown[] }`, forward-compat) — a local cast at the
			// boundary onto the engine's `AddressTree` contract, matching the established idiom (api-kit's
			// `openapi.ts`, the drop-ins' response casts) for "documented wire shape looser than the domain type".
			const outcome = await engine.resolveTree(tree as unknown as AddressTree, opts ?? {})

			return c.json(outcome, 200)
		},
		(result, c) => {
			if (!result.success) return c.json({ error: "body must be { tree: AddressTree, opts? }" }, 400)

			return undefined
		}
	)

	app.openapi(reloadRoute, async (c) => {
		if (!engine.reload) return c.json({ error: "geocoder not available" }, 503)
		const outcome = await engine.reload()

		return c.json(outcome, 200)
	})

	app.openapi(formatRoute, (c) => {
		const { components, country, options: formatOptions } = c.req.valid("json")
		const dict = toComponentDict(components)
		const formatted = formatAddress(dict, country, formatOptions as FormatAddressOptions | undefined)

		return c.json({ formatted, canonicalKey: canonicalKey(dict) }, 200)
	})

	app.openapi(healthRoute, (c) => {
		const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000)

		return c.json({ status: "ok", uptime_s: uptimeSeconds, ...engine.health?.() }, 200)
	})

	app.openapi(metricsRoute, (c) => c.json(metricsSnapshot(), 200))
}
