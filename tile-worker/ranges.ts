/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Parse a Range header into an offset and length.
 */
export function parseRangeHeader(headerContent: string | null): { offset: number; length: number } | null {
	if (!headerContent) return null

	const [unit, range] = headerContent.split("=")

	if (unit !== "bytes") {
		throw new Error(`Unknown unit in Range header: ${unit}`)
	}

	const [start, end] = range!.split("-").map((num) => Number.parseInt(num, 10))

	if (isNaN(start!) || isNaN(end!)) {
		throw new TypeError(`Invalid Range header: ${headerContent}`)
	}

	return {
		offset: start!,
		length: end! - start! + 1,
	}
}
