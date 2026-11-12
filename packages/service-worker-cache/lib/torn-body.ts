// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A Workbox plugin that keeps a torn response out of Cache Storage: one whose body
 *   is shorter or longer than its `Content-Length` header states.
 *
 *   Mobile Safari's HTTP cache can hand a service worker such a body, and a cache-first
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
	if (!hasCheckableContentLength(response)) return true

	return bodyHasLength(response, Number(response.headers.get("content-length")))
}

/**
 * The decoded byte length a request's file must have, from a source other than the response,
 * such as a release manifest, or `null` when no source states one.
 */
export type ExpectedLengthLookup = (request: Request) => number | null | Promise<number | null>

export interface TornBodyPluginOptions {
	/**
	 * Supplies a length to check a response against when the response's own `Content-Length`
	 * can't be checked: the header is missing, or it states an encoded length.
	 *
	 * An origin that serves a file without `Content-Length` otherwise leaves a
	 * truncated body nothing to be compared with.
	 */
	expectedLength?: ExpectedLengthLookup
}

/**
 * Whether a response's decoded body is `expected` bytes long.
 */
async function bodyHasLength(response: Response, expected: number): Promise<boolean> {
	const body = await response.clone().arrayBuffer()

	return body.byteLength === expected
}

/**
 * Whether a response's own `Content-Length` can be compared with its decoded body.
 */
function hasCheckableContentLength(response: Response): boolean {
	const declared = response.headers.get("content-length")
	const encoding = response.headers.get("content-encoding")

	return declared != null && (!encoding || encoding === "identity") && Number.isSafeInteger(Number(declared))
}

/**
 * The plugin.
 *
 * Its `cacheWillUpdate` returns `null` for a torn response, so the strategy answers
 * the request with the response and leaves the cache unchanged.
 * A response that passes is stored unchanged.
 *
 * A response with a checkable `Content-Length` is checked against it.
 * Otherwise the response is checked against `options.expectedLength`, and passes
 * when the lookup states no length.
 */
export function tornBodyPlugin(options: TornBodyPluginOptions = {}): WorkboxPlugin {
	return {
		cacheWillUpdate: async ({ request, response }) => {
			if (hasCheckableContentLength(response)) {
				return (await bodyMatchesContentLength(response)) ? response : null
			}

			// Without a checkable header, only an outside source can say how long the body should be.

			const expected = options.expectedLength ? await options.expectedLength(request) : null

			if (typeof expected !== "number") return response

			return (await bodyHasLength(response, expected)) ? response : null
		},
	}
}
