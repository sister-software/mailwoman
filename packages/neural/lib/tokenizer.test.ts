/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { mtfWASMURL, type MTFWasmSource } from "@mailwoman/mtf"
import { beforeAll, describe, expect, test, vi } from "vitest"

const MODEL_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

/**
 * The mtf runtime compiled to a `WebAssembly.Module`, as a Worker's bundler supplies it.
 *
 * mtf types a compiled module opaquely so its declarations need no DOM library,
 * so the cast states which source this is.
 */
async function compileRuntime(): Promise<MTFWasmSource> {
	const bytes = await readLocalBuffer(mtfWASMURL())

	return (await WebAssembly.compile(new Uint8Array(bytes))) as MTFWasmSource
}

describe("setTokenizerRuntimeSource", () => {
	// The runtime is one per module graph.
	// A worker can share its graph with an earlier test file.
	// These tests read a fresh graph and run in order: the first sets the source, the second finds it set.
	let MailwomanTokenizer: typeof import("#tokenizer").MailwomanTokenizer
	let setTokenizerRuntimeSource: typeof import("#tokenizer").setTokenizerRuntimeSource

	beforeAll(async () => {
		vi.resetModules()
		;({ MailwomanTokenizer, setTokenizerRuntimeSource } = await import("#tokenizer"))
	})

	test("a tokenizer loads over a precompiled module, as a Worker supplies it", async () => {
		const compiled = await compileRuntime()

		setTokenizerRuntimeSource(compiled)

		const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)
		const { ids, pieces } = tokenizer.encode("1600 Pennsylvania Ave NW")

		expect(ids.length).toBeGreaterThan(0)
		expect(pieces.map((p) => p.id)).toEqual(ids)
	})

	test("refuses a second source once the runtime is loading", async () => {
		const compiled = await compileRuntime()

		expect(() => setTokenizerRuntimeSource(compiled)).toThrow(/already loading/u)
	})
})
