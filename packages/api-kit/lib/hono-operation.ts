/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Map a framework-neutral {@link APIOperation} onto `@hono/zod-openapi`'s `createRoute`.
 */

import type { RouteConfig } from "@hono/zod-openapi"
import type { z } from "zod"

import { type APIOperation, type APIResponseKey, namedSchemaOf, responseDescription } from "#operation"

type NoFields = Record<never, never>

type JSONContent<S> = Record<"application/json", { schema: S }>

type HonoResponses<R> = {
	[K in keyof R]: { description: string; content: JSONContent<R[K]> }
}

type HonoRequest<S extends APIOperation["schema"]> = (S["querystring"] extends z.ZodType
	? { query: S["querystring"] }
	: NoFields) &
	(S["params"] extends z.ZodType ? { params: S["params"] } : NoFields) &
	(S["headers"] extends z.ZodType ? { headers: S["headers"] } : NoFields) &
	(S["body"] extends z.ZodType ? { body: { content: JSONContent<S["body"]>; required: true } } : NoFields)

/**
 * The `createRoute` config an operation maps to.
 */
export type HonoRouteOf<O extends APIOperation> = Omit<RouteConfig, "method" | "request" | "responses"> & {
	method: Lowercase<O["method"]>
	request: HonoRequest<O["schema"]>
	responses: HonoResponses<O["schema"]["response"]>
}

/**
 * Convert a Fastify-style pathname (`/v1/places/:id`) to the OpenAPI form (`/v1/places/{id}`).
 */
function openAPIPath(pathname: string): string {
	return pathname.replaceAll(/:(\w+)/g, "{$1}")
}

/**
 * Build the Hono route for an operation.
 *
 * Status-class keys (`"2xx"`) are emitted as OpenAPI's upper-case form (`"2XX"`).
 */
export function toHonoRoute<const O extends APIOperation>(operation: O): HonoRouteOf<O> {
	const { schema } = operation
	const request: Record<string, unknown> = {}

	if (schema.querystring) {
		request["query"] = schema.querystring
	}

	if (schema.params) {
		request["params"] = schema.params
	}

	if (schema.headers) {
		request["headers"] = schema.headers
	}

	if (schema.body) {
		request["body"] = { content: { "application/json": { schema: schema.body } }, required: true }
	}

	const responses: Record<string, unknown> = {}

	for (const [key, responseSchema] of Object.entries(schema.response)) {
		if (!responseSchema) continue

		const responseKey = (/^\d+$/.test(key) ? Number(key) : key) as APIResponseKey
		const openAPIKey = typeof responseKey === "number" ? responseKey : responseKey.toUpperCase()

		responses[openAPIKey] = {
			description: responseDescription(responseSchema, responseKey),
			content: { "application/json": { schema: namedSchemaOf(responseSchema) } },
		}
	}

	return {
		method: operation.method.toLowerCase() as Lowercase<O["method"]>,
		path: openAPIPath(operation.pathname),
		operationId: schema.operationId,
		summary: schema.summary,
		description: schema.description,
		tags: schema.tags ? [...schema.tags] : undefined,
		request: request as HonoRequest<O["schema"]>,
		responses: responses as HonoResponses<O["schema"]["response"]>,
	}
}
