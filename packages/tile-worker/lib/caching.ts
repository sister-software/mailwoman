/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The tile Worker's response cache: Cloudflare's per-colo cache, keyed by request URL. Every route checks it
 *   before its handler runs, and the routes that serve immutable content store their responses in it.
 */

import type { Context, MiddlewareHandler } from "hono"

/**
 * The cache name.
 * A new name starts every colo with an empty cache.
 */
const CACHE_NAME = "2026-26-15-00-00-00"

/**
 * A store that holds responses keyed by URL.
 */
export interface ResponseCache {
	match(url: string): Promise<Response | null>
	put(url: string, response: Response): Promise<void>
}

/**
 * The Workers runtime's cache under {@link CACHE_NAME}.
 */
export function edgeResponseCache(): ResponseCache {
	return {
		async match(url) {
			const cache = await caches.open(CACHE_NAME)

			return (await cache.match(url)) ?? null
		},
		async put(url, response) {
			const cache = await caches.open(CACHE_NAME)

			await cache.put(url, response)
		},
	}
}

/**
 * The Hono environment the tile Worker's routes share.
 */
export interface TileWorkerHono {
	Bindings: TileWorkerEnv
	Variables: { cache: ResponseCache }
}

/**
 * Environment bindings of the tile Worker.
 */
export interface TileWorkerEnv {
	MAILWOMAN_TILES_BUCKET: R2Bucket
	PMTILES_PATH: string
}

/**
 * Answers a request from the cache when it holds the URL, before the route's handler runs.
 *
 * The cached response is copied so the CORS middleware can set this request's headers on it.
 */
export const fromCache: MiddlewareHandler<TileWorkerHono> = async (c, next) => {
	const cached = await c.var.cache.match(c.req.url)

	if (cached) return new Response(cached.body, cached)

	await next()
}

/**
 * Stores a copy of `response` under the request's URL once the request has been answered.
 */
export function cacheResponse(c: Context<TileWorkerHono>, response: Response): void {
	c.executionCtx.waitUntil(c.var.cache.put(c.req.url, response.clone()))
}
