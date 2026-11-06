// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A Workbox plugin that keeps a torn response out of Cache Storage: one whose body is shorter or longer than its
 *   `Content-Length` header states. Mobile Safari's HTTP cache can hand a service worker such a body, and a cache-first
 *   route would otherwise answer every later request for that URL with it.
 */

import type { WorkboxPlugin } from "workbox-core/types.js"

/**
 * Whether a response's body length agrees with its `Content-Length`.
 *
 * A response passes when the check has no length to compare: it has no header,
 * or its body is encoded and the header states the encoded length.
 */
export async function bodyMatchesContentLength(response: Response): Promise<boolean> {
	const declared = response.headers.get("content-length")
	const encoding = response.headers.get("content-encoding")

	if (declared == null || (encoding && encoding !== "identity")) return true

	const expected = Number(declared)

	if (!Number.isSafeInteger(expected)) return true

	const body = await response.clone().arrayBuffer()

	return body.byteLength === expected
}

/**
 * The plugin.
 *
 * Its `cacheWillUpdate` returns `null` for a torn response, so the strategy answers
 * the request with the response and leaves the cache unchanged.
 * A response that passes is stored unchanged.
 */
export function tornBodyPlugin(): WorkboxPlugin {
	return {
		cacheWillUpdate: async ({ response }) => ((await bodyMatchesContentLength(response)) ? response : null),
	}
}
