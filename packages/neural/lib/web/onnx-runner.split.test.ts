/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A split release's encoder plus its embedding rows reproduces the unsplit graph in the web runner,
 *   with the missing rows read through HTTP range requests.
 *
 *   The fixture is written by `packages/neural/test/fixtures/generate-split-embeddings.py`.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, test } from "vitest"

import { EmbeddingTable, httpEmbeddingRangeReader } from "#embedding/rows"
import { WebONNXRunner } from "#web/onnx-runner"

import { installORTWasmBinary } from "../../test/ort-wasm-binary.ts"

await installORTWasmBinary()

const fixture = async (name: string) =>
	new Uint8Array(
		await readLocalBuffer(resolvePackagePath("@mailwoman/neural", "test", "fixtures", "split-embeddings", name))
	)

/**
 * Serves `bytes` at one URL and answers a `Range` header the way R2 does.
 */
function rangeServer(bytes: Uint8Array): { fetch: typeof fetch; ranges: string[] } {
	const ranges: string[] = []

	const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
		const range = new Headers(init?.headers).get("range")

		if (!range) return new Response(bytes.slice(), { status: 200 })

		ranges.push(range)
		const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range)!

		return new Response(bytes.slice(Number(first), Number(last) + 1), { status: 206 })
	}) as typeof fetch

	return { fetch: fetchImpl, ranges }
}

describe("WebONNXRunner over a split release", () => {
	const tokenIDs = [5, 41, 0, 63, 6, 6, 17]

	test("matches the unsplit graph, reading the rows the hot subset omits by range", async () => {
		const server = rangeServer(await fixture("embeddings.rows"))

		const embeddings = EmbeddingTable.fromBytes(
			await fixture("embeddings-hot.bin"),
			httpEmbeddingRangeReader("https://example.test/embeddings.rows", server.fetch)
		)

		const unsplit = await WebONNXRunner.fromBytes(await fixture("model.onnx"), { fixedSeqLen: 16 })
		const split = await WebONNXRunner.fromBytes(await fixture("encoder.onnx"), { fixedSeqLen: 16, embeddings })

		const expected = await unsplit.infer(tokenIDs)
		const actual = await split.infer(tokenIDs)

		expect(actual.logits).toEqual(expected.logits)
		expect(server.ranges.length).toBeGreaterThan(0)

		const reads = server.ranges.length

		await split.infer(tokenIDs)

		expect(server.ranges).toHaveLength(reads)

		await Promise.all([unsplit.release(), split.release()])
	})

	test("refuses a range response that is not 206", async () => {
		const rows = await fixture("embeddings.rows")
		const fetchImpl: typeof fetch = async () => new Response(rows.slice(), { status: 200 })

		const embeddings = EmbeddingTable.fromBytes(
			await fixture("embeddings-hot.bin"),
			httpEmbeddingRangeReader("x", fetchImpl)
		)

		await expect(embeddings.embed([41], 4)).rejects.toThrow(/206/)
	})
})
