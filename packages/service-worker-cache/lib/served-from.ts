// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A Workbox plugin that marks an answer read from Cache Storage with a header, so the page
 *   can tell a stored copy from a network response when it records where an artifact came from.
 */

import type { WorkboxPlugin } from "workbox-core/types.js"

/**
 * The plugin.
 *
 * Its `cachedResponseWillBeUsed` returns the stored response with `header` set to `service-worker`.
 * The copy shares the stored body stream, so marking it reads no bytes.
 *
 * Place it after any plugin that may refuse the stored response.
 */
export function servedFromCachePlugin(header: string): WorkboxPlugin {
	return {
		cachedResponseWillBeUsed: async ({ cachedResponse }) => {
			if (!cachedResponse) return null

			const headers = new Headers(cachedResponse.headers)

			headers.set(header, "service-worker")

			return new Response(cachedResponse.body, {
				status: cachedResponse.status,
				statusText: cachedResponse.statusText,
				headers,
			})
		},
	}
}
