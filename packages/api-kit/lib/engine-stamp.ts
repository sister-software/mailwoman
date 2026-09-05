/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The engine stamp on the HTTP side: the zod schema every app documents it with, the two headers every response
 *   carries, and the helper that attaches the body field. The stamp itself is built by the `mailwoman` package and
 *   arrives as an option value, because the app packages may not depend on `mailwoman`.
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
	.openapi("EngineStamp")

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
): T | (T & { engine: EngineStamp }) {
	return stamp ? { ...body, engine: stamp } : body
}
