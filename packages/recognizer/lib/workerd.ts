// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The Cloudflare Workers entry, selected by the `workerd` export condition.
 *
 *   Workers refuse to compile WebAssembly from bytes, so this entry imports the
 *   package's own `recognizer.wasm` instead of the embedded copy.
 *   The bundler or the platform compiles it at deploy time, and the first
 *   recognition instantiates it synchronously.
 *   The path is the same from `lib/` and from `out/`.
 */

import { setDefaultSource } from "#runtime/state"

import wasmModule from "../wasm/recognizer.wasm"

setDefaultSource(() => wasmModule)

export * from "#exports"

export { IR_FORMAT, IR_VERSION } from "#ir"
