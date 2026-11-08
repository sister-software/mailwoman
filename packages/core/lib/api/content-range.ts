/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the complete length a `Content-Range` response header states.
 */

/**
 * The complete length in bytes a `Content-Range` header states, from either
 * `bytes <start>-<end>/<length>` or the `bytes *\/<length>` form a 416 response sends,
 * or `null` when the header is absent or states the length as `*`.
 */
export function contentRangeTotal(header: string | null | undefined): number | null {
	const length = header ? /^bytes (?:\d+-\d+|\*)\/(\d+)$/u.exec(header.trim())?.[1] : undefined

	return length ? Number(length) : null
}

/**
 * The complete length of the resource a ranged response belongs to, read from its `Content-Range`,
 * or else `offset` plus its `Content-Length`, or `null` when the response states neither.
 *
 * @param offset The byte the request asked the response to start at.
 */
export function rangedResponseTotal(response: Pick<Response, "headers">, offset: number): number | null {
	const total = contentRangeTotal(response.headers.get("content-range"))

	if (total != null) return total

	const length = response.headers.get("content-length")

	return length ? offset + Number(length) : null
}
