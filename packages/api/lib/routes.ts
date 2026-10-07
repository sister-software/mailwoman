/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Handlers for the native operations. Each operation is defined in `#operations/*`. The
 *   OpenAPI document is emitted from those definitions, so there is no handwritten spec.
 */

import type { OpenAPIHono } from "@hono/zod-openapi"
import { geocoderUnavailableError, metricsSnapshot, recordTimed, withEngineStamp } from "@mailwoman/api-kit"
import { toHonoRoute } from "@mailwoman/api-kit/hono-operation"
import { type ComponentDict, formatAddress, type FormatAddressOptions } from "@mailwoman/codex/address/format"
import { canonicalKey } from "@mailwoman/codex/address/key"
import type { ComponentTag } from "@mailwoman/codex/component"
import type { EngineStamp } from "@mailwoman/core/license"

import type { MailwomanAPIEngine } from "#engine"
import { FormatAddressOperation } from "#operations/format-address"
import { GeocodeAddressOperation } from "#operations/geocode/address"
import { GeocodeBatchOperation } from "#operations/geocode/batch"
import { ParseAddressOperation } from "#operations/parse/address"
import { ParseAddressQueryOperation } from "#operations/parse/address/query"
import { ReloadDataOperation } from "#operations/reload-data"
import { ResolveTreeOperation } from "#operations/resolve-tree"
import { RetrieveHealthOperation } from "#operations/retrieve/health"
import { RetrieveMetricsOperation } from "#operations/retrieve/metrics"

/**
 * Default `post /v1/batch` row cap when {@link RegisterMailwomanAPIRoutesOptions.batchMax} is omitted.
 *
 * The standalone-engine default: `mailwoman serve` always passes the env-derived value explicitly.
 */
export const DEFAULT_BATCH_MAX = 500

const startedAt = Date.now()

/**
 * Options for {@link registerMailwomanAPIRoutes}.
 */
export interface RegisterMailwomanAPIRoutesOptions {
	batchMax?: number

	/**
	 * Attached as `engine` to every `/v1` success body.
	 * Absent adds no field.
	 */
	engine?: EngineStamp
}

/**
 * `components` accepts `string | string[]` per key on the wire, but `formatAddress`
 * and `canonicalKey` take a single string per `ComponentTag`; multi-span values collapse
 * to their first span because the formatter template owns joining semantics.
 */
function toComponentDict(components: Record<string, string | string[]>): ComponentDict {
	const out: ComponentDict = {}

	for (const [key, value] of Object.entries(components)) {
		const first = Array.isArray(value) ? value[0] : value

		if (first) {
			out[key as ComponentTag] = first
		}
	}

	return out
}

/**
 * Register the native `/v1` routes + `/health` + `/metrics` against an injected engine.
 */
export function registerMailwomanAPIRoutes(
	app: OpenAPIHono,
	engine: MailwomanAPIEngine,
	options: RegisterMailwomanAPIRoutesOptions = {}
): void {
	const batchMax = options.batchMax ?? DEFAULT_BATCH_MAX
	const stamp = options.engine

	app.openapi(toHonoRoute(ParseAddressQueryOperation), async (c) => {
		if (!engine.parse) return c.json({ error: "parse not implemented", detail: null }, 501)

		const query = c.req.valid("query")
		const address = query.address?.trim()

		if (!address) return c.json({ error: "address is required", detail: null }, 400)
		const response = await engine.parse(address, { debug: query.debug === "true", inputMode: query.input_mode })

		return c.json(withEngineStamp(response, stamp), 200)
	})

	app.openapi(
		toHonoRoute(ParseAddressOperation),
		async (c) => {
			if (!engine.parse) {
				return c.json({ error: "parse not implemented", detail: null }, 501)
			}

			const { address, debug, input_mode } = c.req.valid("json")
			const trimmed = address.trim()

			if (!trimmed) {
				return c.json({ error: "address is required", detail: null }, 400)
			}

			const response = await engine.parse(trimmed, { debug, inputMode: input_mode })

			return c.json(withEngineStamp(response, stamp), 200)
		},
		(result, c) => {
			if (!result.success) return c.json({ error: "address is required", detail: null }, 400)

			return undefined
		}
	)

	app.openapi(
		toHonoRoute(GeocodeAddressOperation),
		async (c) => {
			if (!engine.geocode) {
				return geocoderUnavailableError(c)
			}

			const { address, input_mode } = c.req.valid("json")
			const trimmed = address.trim()

			if (!trimmed) return c.json({ error: "address is required", detail: null }, 400)
			const t0 = performance.now()

			return engine
				.geocode(trimmed, { inputMode: input_mode })
				.then((result) => {
					recordTimed(performance.now() - t0, result.resolution_tier)

					return c.json(withEngineStamp(result, stamp), 200)
				})
				.catch((error) => {
					recordTimed(performance.now() - t0, "error")

					throw error
				})
		},
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "address is required", detail: null }, 400)
			}

			return undefined
		}
	)

	app.openapi(
		toHonoRoute(GeocodeBatchOperation),
		async (c) => {
			const { addresses, input_mode } = c.req.valid("json")

			if (!addresses.length) return c.json(withEngineStamp({ results: [] }, stamp), 200)

			if (addresses.length > batchMax) {
				return c.json({ error: `batch too large: ${addresses.length} > ${batchMax}`, detail: null }, 413)
			}

			if (!engine.batch) {
				return geocoderUnavailableError(c)
			}

			const t0 = performance.now()

			try {
				const response = await engine.batch(addresses, { inputMode: input_mode })
				recordTimed(performance.now() - t0, "batch")

				return c.json(withEngineStamp(response, stamp), 200)
			} catch (error) {
				recordTimed(performance.now() - t0, "error")
				throw error
			}
		},
		(result, c) => {
			if (!result.success) return c.json({ error: "body must be { addresses: string[] }", detail: null }, 400)

			return undefined
		}
	)

	app.openapi(
		toHonoRoute(ResolveTreeOperation),
		async (c) => {
			if (!engine.resolveTree) {
				return geocoderUnavailableError(c, "resolver")
			}

			const { tree, opts } = c.req.valid("json")

			const response = await engine.resolveTree(tree, opts)

			return c.json(withEngineStamp(response, stamp), 200)
		},
		(result, c) => {
			if (!result.success) return c.json({ error: "body must be { tree: AddressTree, opts? }", detail: null }, 400)

			return undefined
		}
	)

	app.openapi(toHonoRoute(ReloadDataOperation), async (c) => {
		if (!engine.reload) {
			return geocoderUnavailableError(c)
		}

		return c.json(await engine.reload(), 200)
	})

	app.openapi(toHonoRoute(FormatAddressOperation), (c) => {
		const { components, country, options: formatOptions } = c.req.valid("json")
		const dict = toComponentDict(components)
		const formatted = formatAddress(dict, country, formatOptions as FormatAddressOptions)

		return c.json(withEngineStamp({ formatted, canonicalKey: canonicalKey(dict) }, stamp), 200)
	})

	app.openapi(toHonoRoute(RetrieveHealthOperation), async (c) => {
		const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000)

		return c.json({ status: "ok" as const, uptime_s: uptimeSeconds, ...(await engine.health?.()) }, 200)
	})

	app.openapi(toHonoRoute(RetrieveMetricsOperation), (c) => c.json(metricsSnapshot(), 200))
}
