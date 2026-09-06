/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The engine stamp on the HTTP side: the zod schema every app documents it with, the two headers every response
 *   carries, and the helper that attaches the body field. The stamp itself is built by the `mailwoman` package and
 *   arrives as an option value: an app factory (`lib/app.ts`, `lib/routes.ts`, `lib/schema.ts`) is engine-agnostic and
 *   must not import `mailwoman`; the bin (`lib/cli.ts`) is the wiring layer that resolves the stamp and passes it in.
 */

import { z } from "@hono/zod-openapi"
import type { EngineStamp } from "@mailwoman/core/license"
import type { MiddlewareHandler } from "hono"

/**
 * Strict on purpose: the stamp carries no licensee and no key id, and a strict object makes a field that leaks one a
 * schema failure rather than a documented extension.
 */
export const EngineStampSchema = z
	.strictObject({
		name: z.literal("mailwoman"),
		version: z.string(),
		license: z.string(),
		license_url: z.string(),
		notice: z.string().optional(),
	})
	.openapi("EngineStamp") satisfies z.ZodType<EngineStamp>

/**
 * A route's response schema once the route attaches the stamp: the body schema intersected with the optional `engine`
 * field. Applied at the ROUTE, never on an outcome schema, so an outcome schema keeps describing what the engine
 * produces (the schema drift pin in `mailwoman` depends on that) and the OpenAPI document references the outcome
 * component through `allOf` instead of cloning it.
 *
 * `name` registers the stamped shape as its own component, and it is required rather than optional because an unnamed
 * intersection is inlined at every use: a generator then has no name to give the type and invents one from the position
 * it appears in — `PhotonResponse::Variant0`, or a flattened per-operation clone of an outcome that already has a name.
 * Naming it keeps one `$ref` per stamped shape, which is what makes a generated client's type names follow the
 * document's.
 */
export function stampedResponseSchema<S extends z.ZodTypeAny>(schema: S, name: string) {
	return z.intersection(schema, z.object({ engine: EngineStampSchema.optional() })).openapi(name)
}

/**
 * `Server` names the engine and its license branch; `Link: rel="license"` is the registered relation (RFC 8288) that
 * lets a proxy, a browser, or `curl -I` find the terms without a body change. Set before the handler runs, so the
 * headers are on the context when any `c.json` — the route's or the error net's — builds its response.
 */
export function engineHeaders(stamp: EngineStamp): MiddlewareHandler {
	const server = `mailwoman/${stamp.version} (${stamp.license})`
	const link = `<${stamp.license_url}>; rel="license"`

	return async (c, next) => {
		c.header("Server", server)
		c.header("Link", link)

		await next()
	}
}

/**
 * Attach the `engine` field when a stamp is configured. The field goes LAST, so a body that already spells a key of the
 * same name keeps the stamp's value.
 */
export function withEngineStamp<T extends object>(
	body: T,
	stamp: EngineStamp | undefined
): T & { engine?: EngineStamp } {
	return stamp ? { ...body, engine: stamp } : body
}
