/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Classification } from "@mailwoman/core/classification"
import { TokenContext } from "@mailwoman/core/tokenization"

import { SolutionMatch } from "./SolutionMatch.ts"

type MaskCode = "V" | "N" | "S" | "P" | "L" | "U" | "A"

/**
 * Mapping of classification labels to mask codes.
 */
export const ClassificationMaskCodeMap = new Map<Classification | "fallback", MaskCode>([
	["venue", "V"],
	["house_number", "N"],
	["street", "S"],
	["postcode", "P"],
	["level", "L"],
	["level_designator", "L"],
	["unit", "U"],
	["unit_designator", "U"],
	["fallback", "A"],
])

/**
 * Mask which shows the areas covered by different types of classification
 *
 * - `N` housenumber
 * - `S` street
 * - `P` postcode
 * - `A` administrative
 * - `L` Level
 * - `U` unit
 *
 * @returns Mask of the input for this solution
 */
export function createMask(context: TokenContext, matches: Iterable<SolutionMatch>): string {
	const { body } = context.span
	const mask = Array.from({ length: body.length }, () => " ")

	// Scan the input letter-by-letter from left-to-right.
	for (let i = 0; i < body.length; i++) {
		// find which fields cover this character (should only be covered by 0 or 1 field)
		const [firstMatch] = Iterator.from(matches).filter((pair) => pair.span.start <= i && pair.span.end >= i)

		if (!firstMatch) continue

		const code = ClassificationMaskCodeMap.get(firstMatch.classification) || ClassificationMaskCodeMap.get("fallback")!

		for (let j = firstMatch.span.start; j < firstMatch.span.end; j++) {
			mask[j] = code
		}

		// Skip forward to avoid scanning the same token again.
		i = firstMatch.span.end
	}

	return mask.join("")
}
