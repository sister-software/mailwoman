/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Hands onnxruntime-web's wasm binary to its runtime when a test runs the browser runner under Node.
 *
 *   The `onnxruntime-web/wasm` entry loads `ort-wasm-simd-threaded.wasm` with `fetch`, and Node's `fetch`
 *   does not read `file:` URLs. A test that drives `WebONNXRunner` under Node calls this before the first
 *   session is created.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { createRequire } from "@mailwoman/core/module/resolvers"
import * as ort from "onnxruntime-web/wasm"

const requireFromHere = createRequire(import.meta.url)

/**
 * Reads the plain wasm build of onnxruntime-web from its package and installs it as `env.wasm.wasmBinary`.
 *
 * It also pins one thread, because the threaded build fetches its worker script by URL as well.
 */
export async function installORTWasmBinary(): Promise<void> {
	ort.env.wasm.numThreads = 1

	ort.env.wasm.wasmBinary = await readLocalBuffer(
		requireFromHere.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm")
	)
}
