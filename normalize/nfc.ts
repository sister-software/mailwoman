/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unicode NFC normalization. For inputs already in NFC (the common case) this is a no-op. When the
 *   input has combining characters (`e` + `́` → `é`), NFC composes them — the normalized string can
 *   be shorter than the raw.
 *
 *   Approximation: we walk the input grapheme-by-grapheme (best effort via codepoint stepping) and
 *   map each output index to the start of its source sequence. Rare CJK edge cases involving
 *   variant selectors may produce off-by-one offsets — acceptable for v1.
 */

import { identityMap } from "./offset-map.js"

export interface NFCResult {
	text: string
	/** `text[i]` came from `input[map[i]]`. */
	map: number[]
	changed: boolean
}

export function applyNFC(input: string): NFCResult {
	const normalized = input.normalize("NFC")

	if (normalized === input) {
		return { text: input, map: identityMap(input.length), changed: false }
	}

	return { text: normalized, map: estimateNFCMap(input, normalized), changed: true }
}

/**
 * Estimate per-output-codepoint offsets. Walks both strings in parallel; emits the next source index for each output
 * position. Imprecise for combining sequences but correct for length-equal NFC outputs (the common length-changing case
 * is when a sequence shortens).
 */
function estimateNFCMap(input: string, output: string): number[] {
	const map: number[] = []
	let inIdx = 0

	for (let outIdx = 0; outIdx < output.length; outIdx++) {
		map.push(inIdx)
		const outCp = output.codePointAt(outIdx)!
		const outStep = outCp > 0xffff ? 2 : 1

		// Walk the input forward by at least one codepoint; absorb any combining marks (0x0300–0x036f).
		if (inIdx < input.length) {
			const inCp = input.codePointAt(inIdx)!
			inIdx += inCp > 0xffff ? 2 : 1

			while (inIdx < input.length) {
				const nextCp = input.codePointAt(inIdx)!

				if (nextCp >= 0x0300 && nextCp <= 0x036f) {
					inIdx += nextCp > 0xffff ? 2 : 1
				} else {
					break
				}
			}
		}

		if (outStep === 2) {
			outIdx += 1
		}
	}

	return map
}
