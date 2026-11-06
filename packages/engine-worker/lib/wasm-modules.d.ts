// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Wrangler's bundler supplies a `.wasm` import as a compiled `WebAssembly.Module`.
 */

declare module "*.wasm" {
	const module: WebAssembly.Module
	export default module
}

/**
 * The tokenizer's runtime, typed as the opaque module `setTokenizerRuntimeSource` accepts.
 */
declare module "@mailwoman/mtf/wasm/mtf.wasm" {
	const module: WebAssembly.Module & import("@mailwoman/mtf").MTFCompiledModule
	export default module
}
