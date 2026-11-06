/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   An in-memory `CacheStorage` for the Node tests. Each cache stores bodies as bytes and answers `match` with a fresh
 *   `Response`, as Cache Storage does, so a test can read a stored entry more than once.
 */

import type { RangeChunkCacheStorage } from "#range-chunks"

interface StoredEntry {
	request: Request
	status: number
	headers: Headers
	body: ArrayBuffer
}

function keyOf(request: RequestInfo | URL): string {
	return typeof request === "string" ? request : request instanceof URL ? request.href : request.url
}

export class MemoryCache implements Pick<Cache, "match" | "put" | "delete" | "keys"> {
	readonly entries = new Map<string, StoredEntry>()

	async match(request: RequestInfo | URL): Promise<Response | undefined> {
		const entry = this.entries.get(keyOf(request))

		return entry && new Response(entry.body.slice(0), { status: entry.status, headers: entry.headers })
	}

	async put(request: RequestInfo | URL, response: Response): Promise<void> {
		const key = keyOf(request)

		this.entries.set(key, {
			request: new Request(key),
			status: response.status,
			headers: new Headers(response.headers),
			body: await response.arrayBuffer(),
		})
	}

	async delete(request: RequestInfo | URL): Promise<boolean> {
		return this.entries.delete(keyOf(request))
	}

	async keys(): Promise<readonly Request[]> {
		return [...this.entries.values()].map(({ request }) => request)
	}
}

export class MemoryCacheStorage implements RangeChunkCacheStorage {
	readonly caches = new Map<string, MemoryCache>()

	async open(name: string): Promise<MemoryCache> {
		let cache = this.caches.get(name)

		if (!cache) {
			cache = new MemoryCache()
			this.caches.set(name, cache)
		}

		return cache
	}
}
