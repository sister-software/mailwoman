/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the committed `wasm/mtf.wasm` through the TypeScript loader against every row of the v0.2.2
 *   reference fixture.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, test } from "vitest"

import { MTF_WASM_URL, MTFRuntime, type MTFEncodeResult } from "#index"

interface ReferenceRow extends MTFEncodeResult {
	text: string
	decoded: string
}

// The tokenizer that every Latin weights package ships (v0.9.0-multisplice), through the data root.
const TOKENIZER_PATH = dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")
const haveTokenizer = await pathExists(TOKENIZER_PATH)

async function loadModel() {
	const runtime = await MTFRuntime.instantiate(new Uint8Array(await readLocalBuffer(MTF_WASM_URL)))

	return runtime.loadModel(new Uint8Array(await readLocalBuffer(TOKENIZER_PATH)))
}

describe("MTF WASM runtime", () => {
	test.skipIf(!haveTokenizer)("reproduces the v0.2.2 reference on every board input", async () => {
		const fixture = await readLocalJSONFile<{ rows: ReferenceRow[] }>(
			workspacePath("mtf", "test", "fixtures", "board-reference-v0.2.2.json")
		)

		using model = await loadModel()

		expect(fixture.rows.length).toBeGreaterThan(0)

		for (const row of fixture.rows) {
			const { ids, pieces, begins, ends } = model.encode(row.text)

			expect({ text: row.text, ids, pieces, begins, ends }).toEqual({
				text: row.text,
				ids: row.ids,
				pieces: row.pieces,
				begins: row.begins,
				ends: row.ends,
			})

			expect(model.decode(ids)).toBe(row.decoded)
		}
	})

	test.skipIf(!haveTokenizer)("rejects an out-of-vocabulary ID and a disposed model", async () => {
		const model = await loadModel()

		expect(() => model.decode([model.vocabSize])).toThrow(/invalid id/)
		model.dispose()
		expect(() => model.encode("1 Main St")).toThrow(/disposed/)
	})

	test("rejects bytes that are not a model", async () => {
		const runtime = await MTFRuntime.instantiate(new Uint8Array(await readLocalBuffer(MTF_WASM_URL)))

		expect(() => runtime.loadModel(new Uint8Array([0xff, 0xff, 0xff]))).toThrow(/failed to load/)
	})
})
