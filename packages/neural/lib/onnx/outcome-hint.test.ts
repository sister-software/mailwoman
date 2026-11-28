// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The compatibility of a graph with the `outcome_hint` input and the `outcome_logits`
 *   output (`docs/engineering/reference/outcome-kinds.mdx`), on both ONNX runtimes.
 *
 *   The fixture under `test/fixtures/outcome-hint/` is a randomly initialized model
 *   exported by `trainer-export`, with the Rust forward's logits at the "no hint" row
 *   and at hint row 2 (`trainer-loop/tests/outcomes.rs` writes both).
 *
 *   ONNX Runtime 1.31.1 can't override an initializer listed as a graph input,
 *   so the export declares `outcome_hint` as a required input.
 *   The previous runtime's feeds hold no `outcome_hint`, and the session refuses them.
 *   The card's `requires.outcome_hint` states the need.
 */

import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import ortNode from "onnxruntime-node"
import * as ortWeb from "onnxruntime-web"
import { describe, expect, it } from "vitest"

import { packOutcomeHintFeed } from "#onnx/feeds"
import { NO_OUTCOME_HINT, outcomeDistribution, outcomeHintID, type OutcomeTable } from "#outcome/table"

interface Fixture {
	input_ids: number[]
	attention_mask: number[]
	hint_classes: string[]
	head_classes: string[]
	cases: Array<{ outcome_hint: number; logits: number[]; outcome_logits: number[] }>
}

const fixtureDir = resolvePackagePath("@mailwoman/neural", "test", "fixtures", "outcome-hint")
const fixture = await readLocalJSONFile<Fixture>(`${fixtureDir}/expected.json`)
const model = new Uint8Array(await readLocalBuffer(`${fixtureDir}/model.onnx`))

const table: OutcomeTable = {
	revision: null,
	sha256: null,
	hintClasses: fixture.hint_classes,
	headClasses: fixture.head_classes,
}

const runtimes = { "onnxruntime-node": ortNode, "onnxruntime-web": ortWeb } as const

function maxDifference(actual: ArrayLike<number>, expected: readonly number[]): number {
	expect(actual).toHaveLength(expected.length)

	return Math.max(...expected.map((v, i) => Math.abs(actual[i]! - v)))
}

describe.each(Object.entries(runtimes))("%s", (_name, ort) => {
	async function session() {
		return ort.InferenceSession.create(model)
	}

	const previousFeeds = () => ({
		input_ids: new ort.Tensor("int64", BigInt64Array.from(fixture.input_ids.map(BigInt)), [1, 4]),
		attention_mask: new ort.Tensor("int64", BigInt64Array.from(fixture.attention_mask.map(BigInt)), [1, 4]),
	})

	it("declares the hint as an input and the head as an output", async () => {
		const s = await session()

		expect(s.inputNames).toContain("outcome_hint")
		expect(s.outputNames.at(-1)).toBe("outcome_logits")
	})

	it("refuses the previous runtime's feeds, which hold no outcome_hint", async () => {
		const s = await session()

		await expect(s.run(previousFeeds())).rejects.toThrow(/outcome_hint/)
	})

	it.each(fixture.cases)("matches the trained model at hint row $outcome_hint", async (expected) => {
		const s = await session()
		const packed = packOutcomeHintFeed(s.inputNames, expected.outcome_hint)!
		const out = await s.run({ ...previousFeeds(), outcome_hint: new ort.Tensor("int64", packed.data, packed.dims) })

		expect(maxDifference(out["logits"]!.data as Float32Array, expected.logits)).toBeLessThan(1e-4)
		expect(maxDifference(out["outcome_logits"]!.data as Float32Array, expected.outcome_logits)).toBeLessThan(1e-4)
	})

	it("feeds the no-hint row when the caller gives no hint", async () => {
		const s = await session()
		const packed = packOutcomeHintFeed(s.inputNames, undefined)!
		const out = await s.run({ ...previousFeeds(), outcome_hint: new ort.Tensor("int64", packed.data, packed.dims) })
		const noHint = fixture.cases.find((c) => c.outcome_hint === NO_OUTCOME_HINT)!

		expect(maxDifference(out["logits"]!.data as Float32Array, noHint.logits)).toBeLessThan(1e-4)
	})
})

describe("outcomeHintID", () => {
	it("maps a listed id to its row, an unlisted child to its parent, and the rest to no hint", () => {
		expect(outcomeHintID(table, "place")).toBe(fixture.hint_classes.indexOf("place"))
		expect(outcomeHintID(table, "address.street")).toBe(fixture.hint_classes.indexOf("address.street"))
		expect(outcomeHintID(table, "place.borough")).toBe(fixture.hint_classes.indexOf("place"))
		expect(outcomeHintID(table, "landmark")).toBe(NO_OUTCOME_HINT)
		expect(outcomeHintID(table, "landmark.peak")).toBe(NO_OUTCOME_HINT)
		expect(outcomeHintID(null, "place")).toBe(NO_OUTCOME_HINT)
	})

	it("packs nothing for a graph without the input", () => {
		expect(packOutcomeHintFeed(["input_ids", "attention_mask"], 2)).toBeNull()
	})
})

describe("outcomeDistribution", () => {
	it("names each head class and sums to one", () => {
		const distribution = outcomeDistribution(table, fixture.cases[0]!.outcome_logits)

		expect(distribution.map((d) => d.outcome)).toEqual(fixture.head_classes)
		expect(distribution.reduce((sum, d) => sum + d.probability, 0)).toBeCloseTo(1, 6)
	})

	it("refuses a head whose width differs from the card", () => {
		expect(() => outcomeDistribution(table, [0, 1])).toThrow(/head_classes/)
	})
})
