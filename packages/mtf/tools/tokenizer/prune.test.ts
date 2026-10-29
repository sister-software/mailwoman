/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { PieceType } from "./model.ts"
import { keepSet } from "./prune.ts"

const VOCABULARY = [
	["<unk>", 0, PieceType.Unknown],
	["<0x41>", 0, PieceType.Byte],
	["▁a", -1, PieceType.Normal],
	["▁road", -2, PieceType.Normal],
	["street", -3, PieceType.Normal],
	["▁lane", -4, PieceType.Normal],
	["NY", 0, PieceType.UserDefined],
] as const

describe("keepSet", () => {
	it("keeps used, evaluated, non-normal and single-code-point pieces", () => {
		const { keep, singleCodepoint } = keepSet(VOCABULARY, [0, 0, 0, 5, 0, 0, 0], [5])

		expect(keep).toEqual([true, true, true, true, false, true, true])
		expect(singleCodepoint).toBe(1)
	})

	it("refuses counts that do not cover the vocabulary", () => {
		expect(() => keepSet(VOCABULARY, [1, 2], [])).toThrow(/counts cover 2/)
	})

	it("refuses an evaluated id outside the vocabulary", () => {
		expect(() => keepSet(VOCABULARY, [0, 0, 0, 0, 0, 0, 0], [7])).toThrow(/outside the vocabulary/)
	})
})
