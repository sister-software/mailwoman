/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A split release's encoder plus its embedding rows reproduces the unsplit graph in the Node runner.
 *
 *   The fixture is written by `packages/neural/test/fixtures/generate-split-embeddings.py`.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, test } from "vitest"

import { openEmbeddingTable } from "#embedding/file"
import { ONNXRunner } from "#onnx/runner"

const fixture = (name: string) => resolvePackagePath("@mailwoman/neural", "test", "fixtures", "split-embeddings", name)

describe("ONNXRunner over a split release", () => {
	const tokenIDs = [5, 41, 0, 63, 6, 6, 17]

	test("matches the unsplit graph with the hot subset and range reads", async () => {
		const unsplit = await ONNXRunner.fromBytes(new Uint8Array(await readLocalBuffer(fixture("model.onnx"))), {
			fixedSeqLen: 16,
		})

		const embeddings = await openEmbeddingTable(fixture("embeddings.rows"), fixture("embeddings-hot.bin"))
		const residentBefore = embeddings.residentRows

		const split = await ONNXRunner.fromBytes(new Uint8Array(await readLocalBuffer(fixture("encoder.onnx"))), {
			fixedSeqLen: 16,
			embeddings,
		})

		const expected = await unsplit.infer(tokenIDs)
		const actual = await split.infer(tokenIDs)

		expect(actual.logits).toEqual(expected.logits)
		expect(embeddings.rangeReads).toBeGreaterThan(0)
		expect(embeddings.residentRows).toBeGreaterThan(residentBefore)
	})

	test("matches the unsplit graph from the full row file alone", async () => {
		const unsplit = await ONNXRunner.fromBytes(new Uint8Array(await readLocalBuffer(fixture("model.onnx"))), {
			fixedSeqLen: 16,
		})

		const embeddings = await openEmbeddingTable(fixture("embeddings.rows"))

		const split = await ONNXRunner.fromBytes(new Uint8Array(await readLocalBuffer(fixture("encoder.onnx"))), {
			fixedSeqLen: 16,
			embeddings,
		})

		expect((await split.infer(tokenIDs)).logits).toEqual((await unsplit.infer(tokenIDs)).logits)
		expect(embeddings.rangeReads).toBe(0)
	})

	test("refuses a split graph without an embedding table", async () => {
		const split = await ONNXRunner.fromBytes(new Uint8Array(await readLocalBuffer(fixture("encoder.onnx"))), {
			fixedSeqLen: 16,
		})

		await expect(split.infer(tokenIDs)).rejects.toThrow(/inputs_embeds/)
	})
})
