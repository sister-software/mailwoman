/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads a published artifact's size from the bucket without downloading it.
 */

import type { APIClient } from "@mailwoman/core/api"
import { stringifyJSON } from "@mailwoman/core/json"

/**
 * Returns the `content-length` a HEAD request against `url` reports.
 *
 * A response without a usable header throws, naming the URL, because a caller that
 * records sizes must not record a missing one as a number.
 * `data status` catches the error and falls back to the registry's surveyed size,
 * and the snapshot writer records the failure in the row it could not fill.
 */
export async function headContentLength(client: APIClient, url: string): Promise<number> {
	const response = await client.fetch({ method: "head", url })
	const header = response.headers["content-length"] as string | undefined
	const length = Number(header)

	if (!header || !Number.isSafeInteger(length) || length < 0) {
		throw new Error(`${url}: HEAD returned no usable content-length, got ${stringifyJSON(header ?? null)}`)
	}

	return length
}
