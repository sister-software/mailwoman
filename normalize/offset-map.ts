/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Utilities for composing per-transform offset maps into the final `raw → normalized` map.
 */

/** Identity map for an input of length `n`: `[0, 1, 2, ..., n-1]`. */
export function identityMap(n: number): number[] {
	const m = new Array<number>(n)

	for (let i = 0; i < n; i++) {
		m[i] = i
	}

	return m
}

/**
 * Compose `inputMap` (input → raw) with `transformMap` (output → input) to produce `outputMap` (output → raw).
 *
 * @example
 * 	// raw = "350 5th" (chars 0..7, double space at 3-4) // input = "350 5th" (identity from
 * 	raw, length 8) // output = "350 5th" (whitespace collapsed, length 7) // inputMap =
 * 	[0,1,2,3,4,5,6,7] // transformMap = [0,1,2,3,5,6,7] (output[3]=' ' came from input[3];
 * 	output[4]='5' from input[5]) // composed = [0,1,2,3,5,6,7]
 */
export function composeMaps(inputMap: number[], transformMap: number[]): number[] {
	const out = new Array<number>(transformMap.length)

	for (let i = 0; i < transformMap.length; i++) {
		const j = transformMap[i]!
		out[i] = inputMap[j] ?? j
	}

	return out
}
