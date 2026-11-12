// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The page-to-worker messages that report and clear the worker's runtime caches by role,
 *   so a page never opens a cache by its build-specific name.
 *
 *   The page sends a request over a `MessageChannel`, and the worker answers on the channel's port.
 */

/**
 * The `type` of {@linkcode CacheControlRequest}.
 */
export const CACHE_CONTROL_MESSAGE_TYPE = "mailwoman-cache-control"

/**
 * - `usage`: report each role's cache and its entry count.
 * - `clear`: delete the caches of the listed roles.
 */
export type CacheControlRequest =
	| { type: typeof CACHE_CONTROL_MESSAGE_TYPE; action: "usage" }
	| { type: typeof CACHE_CONTROL_MESSAGE_TYPE; action: "clear"; roles: readonly string[] }

/**
 * One role's cache as the worker reports it.
 */
export interface CacheRoleUsage {
	role: string
	cacheName: string
	entries: number
}

export type CacheControlReply =
	| { action: "usage"; usage: CacheRoleUsage[] }
	| { action: "clear"; cleared: string[] }
	| { action: "error"; error: string }

/**
 * The part of Cache Storage the worker's answer uses: `CacheStorage` satisfies it,
 * and so does a test's in-memory store.
 */
export interface CacheControlStorage {
	has(cacheName: string): Promise<boolean>
	open(cacheName: string): Promise<Pick<Cache, "keys">>
	delete(cacheName: string): Promise<boolean>
}

export function isCacheControlMessage(data: unknown): data is CacheControlRequest {
	if (typeof data !== "object" || data == null) return false

	const { type, action, roles } = data as { type?: unknown; action?: unknown; roles?: unknown }

	if (type !== CACHE_CONTROL_MESSAGE_TYPE) return false

	return action === "usage" || (action === "clear" && Array.isArray(roles) && roles.every((r) => typeof r === "string"))
}

/**
 * The worker's answer to `request`, given the cache name each role maps to.
 *
 * A role the map doesn't hold is skipped, so a page can't name a cache outside the worker's own.
 * A cache that was never opened reports zero entries.
 */
export async function answerCacheControl(
	request: CacheControlRequest,
	storage: CacheControlStorage,
	cacheNamesByRole: Readonly<Record<string, string>>
): Promise<CacheControlReply> {
	try {
		if (request.action === "usage") {
			const usage = await Promise.all(
				Object.entries(cacheNamesByRole).map(async ([role, cacheName]) => ({
					role,
					cacheName,
					entries: (await storage.has(cacheName)) ? (await (await storage.open(cacheName)).keys()).length : 0,
				}))
			)

			return { action: "usage", usage }
		}

		const cleared: string[] = []

		for (const role of request.roles) {
			const cacheName = cacheNamesByRole[role]

			if (cacheName && (await storage.delete(cacheName))) {
				cleared.push(role)
			}
		}

		return { action: "clear", cleared }
	} catch (error) {
		return { action: "error", error: error instanceof Error ? error.message : String(error) }
	}
}

/**
 * How long the page waits for the worker's answer.
 */
const CACHE_CONTROL_TIMEOUT_MS = 10_000

/**
 * Sends `request` to the page's controlling service worker and resolves its answer.
 *
 * A page with no controlling worker resolves an `error` reply, as does a worker that
 * doesn't answer within {@link CACHE_CONTROL_TIMEOUT_MS}.
 */
export function requestCacheControl(request: CacheControlRequest): Promise<CacheControlReply> {
	const controller = globalThis.navigator?.serviceWorker?.controller

	if (!controller) return Promise.resolve({ action: "error", error: "no service worker controls this page" })

	return new Promise((resolve) => {
		const channel = new MessageChannel()

		const timer = setTimeout(() => {
			channel.port1.close()
			resolve({ action: "error", error: `the service worker didn't answer in ${CACHE_CONTROL_TIMEOUT_MS} ms` })
		}, CACHE_CONTROL_TIMEOUT_MS)

		channel.port1.onmessage = (event: MessageEvent<CacheControlReply>) => {
			clearTimeout(timer)
			channel.port1.close()
			resolve(event.data)
		}

		controller.postMessage(request, [channel.port2])
	})
}
