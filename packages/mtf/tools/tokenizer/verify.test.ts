/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pruning checks against tokenizers and graphs that disagree on purpose. Both checks are one-sided: a check
 *   that under-counts reports a sound surgery, so each case is a known difference the check must find.
 */

import { describe, expect, it } from "vitest"

import {
	checkLogitParity,
	checkSegmentationIdentity,
	type Feed,
	feedsFor,
	type InputMeta,
	type LogitSession,
	type PieceEncoder,
} from "./verify.ts"

/**
 * Original id to pruned id.
 * This map drops id 3.
 */
const OLD_TO_NEW = [0, 1, 2, -1, 3, 4]

function encoder(table: Record<string, number[]>): PieceEncoder {
	return {
		encode: (text) => ({ ids: table[text]!, pieces: [...text] }),
	}
}

const METAS: InputMeta[] = [
	{ name: "input_ids", type: "int64", shape: ["batch", "sequence"] },
	{ name: "attention_mask", type: "int64", shape: ["batch", "sequence"] },
	{ name: "anchor_features", type: "float32", shape: ["batch", "sequence", "23"] },
]

function session(outputs: Record<string, Float32Array[]>): LogitSession {
	return {
		inputs: METAS,
		run: async (feeds: Record<string, Feed>) => outputs[[...feeds["input_ids"]!.data].join(",")]!,
	}
}

describe("checkSegmentationIdentity", () => {
	it("counts no difference when the renumbered ids agree", () => {
		const original = encoder({ a: [1, 2], b: [4, 5] })
		const pruned = encoder({ a: [1, 2], b: [3, 4] })

		expect(checkSegmentationIdentity(original, pruned, OLD_TO_NEW, ["a", "b"], "case")).toBe(0)
	})

	it("counts a dropped piece as a difference", () => {
		expect(
			checkSegmentationIdentity(encoder({ gone: [1, 3] }), encoder({ gone: [1, 2] }), OLD_TO_NEW, ["gone"], "case")
		).toBe(1)
	})

	it("counts a resegmented text as a difference", () => {
		expect(
			checkSegmentationIdentity(encoder({ split: [4, 5] }), encoder({ split: [3] }), OLD_TO_NEW, ["split"], "case")
		).toBe(1)
	})
})

describe("feedsFor", () => {
	it("resolves every symbolic dimension and feeds the channels zeros", () => {
		const feeds = feedsFor(METAS, [1, 2, 4])

		expect([...feeds["input_ids"]!.data]).toEqual([1n, 2n, 4n])
		expect(feeds["attention_mask"]!.dims).toEqual([1, 3])
		expect([...feeds["attention_mask"]!.data]).toEqual([1n, 1n, 1n])
		expect(feeds["anchor_features"]!.dims).toEqual([1, 3, 23])
		expect(feeds["anchor_features"]!.data).toBeInstanceOf(Float32Array)
		expect([...feeds["anchor_features"]!.data].every((v) => v === 0)).toBe(true)
	})

	it("refuses a dimension it cannot resolve", () => {
		expect(() => feedsFor([{ name: "x", type: "float32", shape: ["batch", "width"] }], [1])).toThrow(/width/)
	})
})

describe("checkLogitParity", () => {
	it("counts no difference for bit-equal outputs", async () => {
		const logits = new Float32Array([0.25, 0.5])

		expect(
			await checkLogitParity(
				encoder({ a: [1, 2] }),
				OLD_TO_NEW,
				session({ "1,2": [logits] }),
				session({ "1,2": [logits.slice()] }),
				["a"]
			)
		).toBe(0)
	})

	it("counts a one-ulp difference, because the check is bitwise", async () => {
		const logits = new Float32Array([0.25, 0.5])
		const nudged = logits.slice()
		const bits = new Uint32Array(nudged.buffer)

		bits[1]! += 1

		expect(
			await checkLogitParity(
				encoder({ a: [4, 5] }),
				OLD_TO_NEW,
				session({ "4,5": [logits] }),
				session({ "3,4": [nudged] }),
				["a"]
			)
		).toBe(1)
	})

	it("refuses an unmapped id rather than scoring it", async () => {
		await expect(
			checkLogitParity(encoder({ gone: [1, 3] }), OLD_TO_NEW, session({}), session({}), ["gone"])
		).rejects.toThrow(/unmapped id/)
	})
})
