// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it, vi } from "vitest"

import { AbortKind, AbortReason } from "#abort"
import type { AddressNode, AddressTree } from "#decoder/types"
import {
	createRequestContext,
	type PipelineStage,
	runStage,
	runStages,
	StageID,
	type StageRecord,
	treeRewriteStage,
} from "#pipeline/stage"

function node(tag: AddressNode["tag"], value: string, start: number, children: AddressNode[] = []): AddressNode {
	return { tag, value, start, end: start + value.length, confidence: 1, children }
}

describe("runStage", () => {
	it("rejects with the signal's typed reason before the stage runs", async () => {
		const controller = new AbortController()
		const reason = new AbortReason(AbortKind.Superseded)
		const run = vi.fn(() => "ran")

		controller.abort(reason)

		const context = createRequestContext({ signal: controller.signal })

		await expect(runStage({ id: StageID.Normalize, run }, "input", context)).rejects.toBe(reason)
		expect(run).not.toHaveBeenCalled()
		expect(context.timing).toEqual({})
	})

	it("records a fault under the published spelling and continues with the recovered output", async () => {
		const context = createRequestContext()
		const cause = new RangeError("the model refused")

		const stage: PipelineStage<string, string[]> = {
			id: StageID.TokenClassify,
			run: () => {
				throw cause
			},
			recover: (input) => [input],
		}

		await expect(runStage(stage, "text", context)).resolves.toEqual(["text"])
		expect(context.faults).toEqual([{ stage: "classifier", name: "RangeError", message: "the model refused", cause }])
		expect(context.timing[StageID.TokenClassify]).toBeGreaterThanOrEqual(0)
	})

	it("rethrows from a stage that declares no recovery", async () => {
		const context = createRequestContext()

		const stage: PipelineStage<string, string> = {
			id: StageID.Resolve,
			run: () => {
				throw new Error("the database closed")
			},
		}

		await expect(runStage(stage, "text", context)).rejects.toThrow("the database closed")
		expect(context.faults).toEqual([])
	})

	it("stops a stage list at the stage after the one that aborted the request", async () => {
		const controller = new AbortController()
		const second = vi.fn((value: number) => value + 1)

		const stages: PipelineStage<number, number>[] = [
			{
				id: StageID.Normalize,
				run: (value) => {
					controller.abort(new AbortReason(AbortKind.Caller))

					return value + 1
				},
			},
			{ id: StageID.QueryShape, run: second },
		]

		await expect(runStages(stages, 0, createRequestContext({ signal: controller.signal }))).rejects.toMatchObject({
			kind: AbortKind.Caller,
		})

		expect(second).not.toHaveBeenCalled()
	})
})

describe("treeRewriteStage", () => {
	const nestUnderRegion = (tree: AddressTree): AddressTree => {
		const [city, state] = tree.roots as [AddressNode, AddressNode]

		tree.roots = [{ ...state, tag: "region", children: [city], metadata: { country_hint: "US" } }]

		return tree
	}

	const cityState = (): AddressTree => ({
		raw: "Dublin, TX",
		roots: [node("locality", "Dublin", 0), node("locality", "TX", 8)],
	})

	it("writes the outline lines an in-place rewrite removed and added", async () => {
		const records: StageRecord[] = []
		const context = createRequestContext({ trace: (record) => void records.push(record) })

		await runStage(treeRewriteStage(StageID.RegionRecognition, nestUnderRegion), cityState(), context)

		expect(records).toEqual([
			{
				kind: "tree-rewrite",
				stage: "region-recognition",
				removed: ['locality [0, 6): "Dublin"', 'locality [8, 10): "TX"'],
				added: ['region [8, 10): "TX" {"country_hint":"US"}', '  locality [0, 6): "Dublin"'],
			},
		])
	})

	it("writes a change that touches only a node's metadata", async () => {
		const records: StageRecord[] = []
		const context = createRequestContext({ trace: (record) => void records.push(record) })

		const annotate = (tree: AddressTree): AddressTree => {
			tree.roots[0]!.metadata = { bare_postcode_retag: true }

			return tree
		}

		await runStage(
			treeRewriteStage(StageID.BarePostcode, annotate),
			{ raw: "SW1A 1AA", roots: [node("postcode", "SW1A 1AA", 0)] },
			context
		)

		expect(records).toEqual([
			{
				kind: "tree-rewrite",
				stage: "bare-postcode",
				removed: ['postcode [0, 8): "SW1A 1AA"'],
				added: ['postcode [0, 8): "SW1A 1AA" {"bare_postcode_retag":true}'],
			},
		])
	})

	it("writes no record for a pass that leaves the tree as it was", async () => {
		const trace = vi.fn()

		await runStage(
			treeRewriteStage(StageID.StrandedAffix, (tree) => tree),
			cityState(),
			createRequestContext({ trace })
		)

		expect(trace).not.toHaveBeenCalled()
	})

	it("applies the rewrite for a request without a trace", async () => {
		const tree = await runStage(
			treeRewriteStage(StageID.RegionRecognition, nestUnderRegion),
			cityState(),
			createRequestContext()
		)

		expect(tree.roots.map((root) => root.tag)).toEqual(["region"])
	})
})
