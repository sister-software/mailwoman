/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { RouteContext } from "./routing.ts"

const CACHE_NAME = "2026-26-15-00-00-00"

export async function retrieveCachedResponse(request: Request): Promise<Response | null> {
	const cache = await caches.open(CACHE_NAME)
	const cached = await cache.match(request.url)

	return cached || null
}

export async function cacheResponse(
	response: Response,
	{ request, ctx }: Pick<RouteContext, "request" | "ctx">
): Promise<void> {
	const clone = response.clone()
	const cache = await caches.open(CACHE_NAME)

	ctx.waitUntil(cache.put(request.url, clone))
}
