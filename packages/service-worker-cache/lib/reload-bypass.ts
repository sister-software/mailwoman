// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A Workbox plugin that lets a page's `cache: "reload"` or `cache: "no-store"` request
 *   pass a cache-first route's stored copy and reach the network.
 *
 *   A cache-first strategy otherwise ignores a request's cache mode, so a page that
 *   retries a file after a bad copy was stored would be handed the same bytes again.
 *   With the plugin, the retry's cache mode asks for fresh bytes in the same request.
 *
 *   The network's answer replaces the stored copy through the route's `cacheWillUpdate` checks.
 *
 *   When the network then fails, as offline, the route answers with the stored copy it
 *   passed over, so a reload made without a connection still gets the file.
 */

import type { WorkboxPlugin } from "workbox-core/types.js"

/**
 * The request cache modes that ask the route to fetch from the network.
 */
const NETWORK_CACHE_MODES: ReadonlySet<RequestCache> = new Set(["reload", "no-store"])

/**
 * The key under which the plugin keeps the passed-over copy in Workbox's per-request plugin state.
 */
const PASSED_OVER = "reloadBypassCachedResponse"

/**
 * Whether a request's cache mode asks for the network rather than a stored copy.
 */
export function requestsNetworkCopy(request: Request): boolean {
	return NETWORK_CACHE_MODES.has(request.cache)
}

/**
 * The plugin.
 *
 * Its `cachedResponseWillBeUsed` returns `null` for a request in `reload`
 * or `no-store` mode, so the strategy fetches from the network.
 * Its `handlerDidError` answers with that passed-over copy when the network fetch fails.
 */
export function reloadBypassPlugin(): WorkboxPlugin {
	return {
		cachedResponseWillBeUsed: async ({ request, cachedResponse, state }) => {
			if (!cachedResponse || !requestsNetworkCopy(request)) return cachedResponse ?? null

			if (state) {
				state[PASSED_OVER] = cachedResponse
			}

			return null
		},
		handlerDidError: async ({ state }) => state?.[PASSED_OVER] as Response | undefined,
	}
}
