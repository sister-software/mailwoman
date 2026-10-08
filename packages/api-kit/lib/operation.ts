/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Framework-neutral API operation definitions.
 *
 * An operation pairs an HTTP method and pathname with a route schema shaped like Fastify's.
 * Fastify consumes it as is, and the Hono adapter (`#hono-operation`) maps it onto `createRoute`.
 * Schemas are plain Zod.
 * A schema registered with `.meta({ id })` becomes an OpenAPI component that responses reference.
 */

import { z } from "zod"

/**
 * The HTTP methods an operation may declare.
 */
export type APIOperationMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/**
 * A response key: an exact status code, a status class such as `"2xx"`, or `"default"`.
 */
export type APIResponseKey = number | `${1 | 2 | 3 | 4 | 5}xx` | "default"

/**
 * The route schema of one operation.
 */
export interface APIOperationSchema {
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- OpenAPI's own key, read verbatim by Fastify and the Hono generator.
	operationId: string
	summary?: string
	description?: string
	tags?: readonly string[]
	querystring?: z.ZodType
	params?: z.ZodType
	headers?: z.ZodType
	body?: z.ZodType
	response: Partial<Readonly<Record<APIResponseKey, z.ZodType>>>
}

/**
 * One API operation: where it is served and what it accepts and returns.
 */
export interface APIOperation {
	method: APIOperationMethod
	pathname: string
	schema: APIOperationSchema
}

/**
 * The OpenAPI tag shared by an operation group.
 */
export interface APITag {
	name: string
	description?: string
}

/**
 * Mark a response or field as a reference to a registered component.
 *
 * The schema must have an `id` in Zod's global registry, set with `.meta({ id })`.
 * Generators then emit `$ref` to that component rather than inlining it.
 */
export function Ref<S extends z.ZodType>(schema: S): S {
	if (!z.globalRegistry.get(schema)?.id) {
		throw new TypeError("Ref: the schema has no registered id; declare it with .meta({ id })")
	}

	return schema
}

/**
 * A response with no body.
 */
export function EmptyResponse(description = "No content."): z.ZodNull {
	return z.null().meta({ description })
}

/**
 * The description an OpenAPI response needs, read from the schema's metadata.
 */
export function responseDescription(schema: z.ZodType, key: APIResponseKey): string {
	return z.globalRegistry.get(schema)?.description ?? `Status ${key}.`
}

/**
 * The registered schema a response refers to.
 *
 * `.meta({ description })` clones the schema, and the clone has no `id`.
 * A generator that does not follow the clone back to its parent inlines it.
 *
 * This function walks back to the nearest ancestor registered with an `id`.
 */
export function namedSchemaOf(schema: z.ZodType): z.ZodType {
	let current: z.ZodType | undefined = schema

	while (current) {
		if (z.globalRegistry.get(current)?.id) return current

		current = current._zod.parent as z.ZodType | undefined
	}

	return schema
}
