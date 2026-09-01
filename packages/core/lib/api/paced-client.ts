/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The paced, disk-cached client factory the layer products' acquisition clients share: courtesy pacing,
 *   bounded retry, and an on-disk response cache under the data root.
 *
 *   NOT exported from the `@mailwoman/core/api` barrel — it reaches `#api/disk-storage`, which imports
 *   `node:fs/promises`, and the barrel serves a browser bundle. Import it from the
 *   `@mailwoman/core/api/paced-client` subpath.
 */

import type { APIClient, APIClientConfig } from "#api/APIClient"
import type { ClockLike } from "#api/clock"
import { buildDiskStorage } from "#api/disk-storage"
import { dataRootPath } from "#data-root"

/**
 * The options every paced-cached client factory accepts.
 */
export interface CreatePacedCachedClientOptions {
	clock?: ClockLike
	cacheDirectory?: string
	minRequestIntervalMs?: number
}

/**
 * The product's own side of the configuration.
 */
export interface PacedCachedClientProduct {
	displayName: string
	/**
	 * The product's courtesy-pacing default, in milliseconds between requests.
	 */
	minRequestIntervalMs: number
	/**
	 * How long a cached response stays fresh — chosen against the product's own cadence, so it lives with the product.
	 */
	cacheTTLMs: number
	/**
	 * Data-root segments of the default on-disk cache directory.
	 */
	cacheDirectory: readonly string[]
}

/**
 * Build one acquisition client with the disk cache and pacing its package's acquisition path expects.
 */
export function createPacedCachedClient<Client extends APIClient>(
	ctor: new (config: APIClientConfig) => Client,
	product: PacedCachedClientProduct,
	options: CreatePacedCachedClientOptions = {}
): Client {
	return new ctor({
		displayName: product.displayName,
		minRequestIntervalMs: options.minRequestIntervalMs ?? product.minRequestIntervalMs,
		retry: true,
		...(options.clock ? { clock: options.clock } : {}),
		caching: {
			ttl: product.cacheTTLMs,
			storage: buildDiskStorage({
				directory: options.cacheDirectory ?? String(dataRootPath(...product.cacheDirectory)),
			}),
		},
	})
}
