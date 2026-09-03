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
import { geocoderUnavailableError, metricsSnapshot, recordTimed } from "@mailwoman/api-kit"
import type { AddressTree } from "@mailwoman/core/decoder"
import type { ComponentTag } from "@mailwoman/core/types"
import { canonicalKey, type ComponentDict, formatAddress, type FormatAddressOptions } from "@mailwoman/formatter"

import type { MailwomanAPIEngine } from "#engine"
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
	type GeocodeOutcome,
} from "#schema"

/**
 * Default `POST /v1/batch` row cap when {@link RegisterMailwomanAPIRoutesOptions.batchMax} is omitted. This is the
 * standalone-engine default, not derived from env — `mailwoman serve` always passes the env-derived value explicitly
 * (`$public.MAILWOMAN_BATCH_MAX`, default 1000; see `core/env/schema.ts`).
 */
export const DEFAULT_BATCH_MAX = 500

const startedAt = Date.now()

/**
 * Options for {@link registerMailwomanAPIRoutes}.
 */
export interface RegisterMailwomanAPIRoutesOptions {
	/**
	 * Max `addresses` rows accepted by `POST /v1/batch`. Default {@link DEFAULT_BATCH_MAX}.
	 */
	batchMax?: number
}

const errorContent = (description: string) => ({
	description,
	content: { "application/json": { schema: APIErrorSchema } },
})

const parseQueryParams = z.object({
	address: z.string().optional().openapi({ description: "The address to parse." }),
	debug: z.string().optional().openapi({ description: '`"true"` to include a diagnostic report.' }),
	input_mode: z
		.enum(["fragmented", "formatted"])
		.optional()
		.openapi({ description: "Input register (Decision A): unset → derived from the input's shape." }),
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
		description: "Versioned data switchover result — the new per-extract version map.",
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
	summary: "Reload versioned data extracts (deploy-only; check at ingress)",
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

/**
 * Register the native `/v1` routes + `/health` + `/metrics` against an injected engine.
 */
export function registerMailwomanAPIRoutes<T extends Partial<GeocodeOutcome> = GeocodeOutcome>(
	app: OpenAPIHono,
	engine: MailwomanAPIEngine<T>,
	options: RegisterMailwomanAPIRoutesOptions = {}
): void {
	const batchMax = options.batchMax ?? DEFAULT_BATCH_MAX

	app.openapi(parseGetRoute, async (c) => {
		if (!engine.parse) return c.json({ error: "parse not implemented" }, 501)

		const address = c.req.query("address")?.trim()

		if (!address) return c.json({ error: "address is required" }, 400)
		const debug = c.req.query("debug") === "true"
		const inputModeRaw = c.req.query("input_mode")
		const inputMode = inputModeRaw === "fragmented" || inputModeRaw === "formatted" ? inputModeRaw : undefined
		const outcome = await engine.parse(address, { debug, inputMode })

		return c.json(outcome, 200)
	})

	app.openapi(
		parsePostRoute,
		async (c) => {
			if (!engine.parse) {
				return c.json({ error: "parse not implemented" }, 501)
			}

			const { address, debug, input_mode } = c.req.valid("json")
			const trimmed = address.trim()

			if (!trimmed) {
				return c.json({ error: "address is required" }, 400)
			}

			const outcome = await engine.parse(trimmed, { debug: debug ?? false, inputMode: input_mode })

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
			if (!engine.geocode) {
				return geocoderUnavailableError(c)
			}

			const { address, input_mode } = c.req.valid("json")
			const trimmed = address.trim()

			if (!trimmed) return c.json({ error: "address is required" }, 400)
			const t0 = performance.now()

			return engine
				.geocode(trimmed, { inputMode: input_mode })
				.then((outcome) => {
					recordTimed(performance.now() - t0, String(outcome.resolution_tier ?? "admin"))

					return c.json(outcome as GeocodeOutcome, 200)
				})
				.catch((error) => {
					recordTimed(performance.now() - t0, "error")

					throw error
				})
		},
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "address is required" }, 400)
			}

			return undefined
		}
	)

	app.openapi(
		batchRoute,
		async (c) => {
			const { addresses, input_mode } = c.req.valid("json")

			if (!addresses.length) return c.json({ results: [] }, 200)

			if (addresses.length > batchMax) {
				return c.json({ error: `batch too large: ${addresses.length} > ${batchMax}` }, 413)
			}

			if (!engine.batch) {
				return geocoderUnavailableError(c)
			}

			// Whole-call latency, recorded under the "batch" tier. Per-row tier metrics are the ENGINE's
			// responsibility (phase 4b) — this app only times the call as a unit.
			const t0 = performance.now()

			try {
				// Decision A endpoint default: batch rows are the record register — formatted unless overridden.
				const outcome = await engine.batch(addresses, { inputMode: input_mode ?? "formatted" })
				recordTimed(performance.now() - t0, "batch")

				// Same wire-vs-domain cast as `/v1/geocode` above — `BatchRow`'s `GeocodeOutcome` half is a
				// `Record<string, unknown>` passthrough; `BatchResponseSchema` now types its `GeocodeOutcome` union
				// member as the real shape.
				return c.json(outcome as z.infer<typeof BatchResponseSchema>, 200)
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
			// `resolver`, not `geocoder` — the missing method is `engine.resolveTree`, and the 503's `error`
			// value is what a caller branches on.
			if (!engine.resolveTree) {
				return geocoderUnavailableError(c, "resolver")
			}

			const { tree, opts } = c.req.valid("json")

			const outcome = await engine.resolveTree(tree as AddressTree, opts ?? {})

			return c.json(outcome, 200)
		},
		(result, c) => {
			if (!result.success) return c.json({ error: "body must be { tree: AddressTree, opts? }" }, 400)

			return undefined
		}
	)

	app.openapi(reloadRoute, async (c) => {
		if (!engine.reload) {
			return geocoderUnavailableError(c)
		}

		const outcome = await engine.reload()

		return c.json(outcome, 200)
	})

	app.openapi(formatRoute, (c) => {
		const { components, country, options: formatOptions } = c.req.valid("json")
		const dict = toComponentDict(components)
		const formatted = formatAddress(dict, country, formatOptions as FormatAddressOptions | undefined)

		return c.json({ formatted, canonicalKey: canonicalKey(dict) }, 200)
	})

	app.openapi(healthRoute, async (c) => {
		const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000)

		return c.json({ status: "ok", uptime_s: uptimeSeconds, ...(await engine.health?.()) }, 200)
	})

	app.openapi(metricsRoute, (c) => c.json(metricsSnapshot(), 200))
}
