/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { composeMaps, identityMap } from "./offset-map.ts"

test("identityMap: [0, 1, …, n-1]", () => {
	expect(identityMap(0)).toEqual([])
	expect(identityMap(1)).toEqual([0])
	expect(identityMap(5)).toEqual([0, 1, 2, 3, 4])
})

test("composeMaps: composing with an identity inputMap returns the transformMap (the docstring case)", () => {
	// raw == input ("350 5th", length 8); output collapsed a double space (length 7).
	const inputMap = identityMap(8)
	const transformMap = [0, 1, 2, 3, 5, 6, 7] // output[4]='5' came from input[5]
	expect(composeMaps(inputMap, transformMap)).toEqual([0, 1, 2, 3, 5, 6, 7])
})

test("composeMaps: chains a non-identity inputMap (output → input → raw)", () => {
	// input → raw already dropped some chars: input[0]→raw0, input[1]→raw2, input[2]→raw4.
	const inputMap = [0, 2, 4]
	// output → input is the identity here (no further drop)…
	expect(composeMaps(inputMap, [0, 1, 2])).toEqual([0, 2, 4])
	// …and a reordering/drop at the output stage composes through to raw indices.
	expect(composeMaps(inputMap, [2, 0])).toEqual([4, 0])
})

test("composeMaps: an out-of-range transform index falls back to the raw index itself", () => {
	// transformMap points past inputMap's end → `inputMap[j] ?? j` yields j.
	expect(composeMaps([0, 1], [0, 1, 2])).toEqual([0, 1, 2])
})

test("composeMaps: empty maps compose to empty", () => {
	expect(composeMaps([], [])).toEqual([])
})
