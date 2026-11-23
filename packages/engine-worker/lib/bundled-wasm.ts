// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The two WebAssembly runtimes the parse needs, as modules wrangler compiles at
 *   deploy time. workerd refuses to compile WebAssembly from bytes, so neither
 *   runtime may fetch and compile its binary at request time.
 *
 *   The tokenizer takes its module through `setTokenizerRuntimeSource`. onnxruntime-web
 *   accepts only bytes as its `wasmBinary`, so the loader hands it {@link ORT_WASM_TAG}
 *   and {@link installBundledWasm} replaces `WebAssembly.instantiate` with a version
 *   that answers those bytes with the bundled module.
 */

// Wrangler's bundler turns each `.wasm` import into a compiled module, and `wasm-modules.d.ts` declares that type.
import mtfModule from "@mailwoman/mtf/wasm/mtf.wasm"
import { setTokenizerRuntimeSource } from "@mailwoman/neural/input/tokenizer"
import ortModule from "onnxruntime-web/ort-wasm-simd-threaded.wasm"

/**
 * The bytes the loader hands onnxruntime-web as its `wasmBinary`, passed to
 * `loadReleaseAssets` as `ortWASMBinary`.
 *
 * A real WebAssembly binary starts with the 4-byte `\0asm` magic, so a 3-byte buffer is never one.
 */
export const ORT_WASM_TAG = new Uint8Array(3)

let installed = false

/**
 * Routes both runtimes to their bundled modules, once per isolate.
 */
export function installBundledWasm(): void {
	if (installed) return

	installed = true

	const instantiate = WebAssembly.instantiate.bind(WebAssembly)

	WebAssembly.instantiate = (async (source: unknown, imports?: WebAssembly.Imports) => {
		if (ArrayBuffer.isView(source) && source.byteLength === ORT_WASM_TAG.byteLength) {
			return { module: ortModule, instance: await instantiate(ortModule, imports) }
		}

		return instantiate(source as WebAssembly.Module, imports)
	}) as typeof WebAssembly.instantiate

	setTokenizerRuntimeSource(mtfModule)
}
