/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared fixtures for the decoder suites: the `DecoderToken` constructor, the recursive tag
 *   lookup, and the White House address the serializer tests walk.
 */

import type { AddressNode, DecoderToken } from "@mailwoman/core/decoder/types"
import type { BIOLabel } from "@mailwoman/core/types/component"

/**
 * Construct a DecoderToken — confidence defaults to 1.0 for fixture brevity.
 */
export function tok(piece: string, start: number, end: number, label: BIOLabel, confidence = 1): DecoderToken {
	return { piece, start, end, label, confidence }
}

/**
 * Depth-first search for the first node carrying `tag`; `null` when absent.
 */
export function findByTag(nodes: AddressNode[], tag: string): AddressNode | null {
	for (const n of nodes) {
		if (n.tag === tag) return n
		const inChild = findByTag(n.children, tag)

		if (inChild) return inChild
	}

	return null
}

export const WHITE_HOUSE_RAW = "1600 Pennsylvania Avenue NW, Washington, DC 20500"

/**
 * "1600 Pennsylvania Avenue NW, Washington, DC 20500" 0 5 18 25 29 41 44
 */
export function whiteHouseTokens(): DecoderToken[] {
	return [
		tok("1600", 0, 4, "B-house_number"),
		tok("Pennsylvania", 5, 17, "B-street"),
		tok("Avenue", 18, 24, "I-street"),
		tok("NW", 25, 27, "I-street"),
		tok(",", 27, 28, "O"),
		tok("Washington", 29, 39, "B-locality"),
		tok(",", 39, 40, "O"),
		tok("DC", 41, 43, "B-region"),
		tok("20500", 44, 49, "B-postcode"),
	]
}
