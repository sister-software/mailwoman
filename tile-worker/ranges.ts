// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Parse a Range header into an offset and length.
 */
export function parseRangeHeader(headerContent: string | null): { offset: number; length: number } | null {
	if (!headerContent) return null

	const [unit, range] = headerContent.split("=")

	if (unit !== "bytes") {
		throw new Error(`Unknown unit in Range header: ${unit}`)
	}

	const [start, end] = range!.split("-").map((num) => parseInt(num, 10))

	if (isNaN(start!) || isNaN(end!)) {
		throw new Error(`Invalid Range header: ${headerContent}`)
	}

	return {
		offset: start!,
		length: end! - start! + 1,
	}
}
