// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The members of the global `WebAssembly` object this loader calls.
 *
 *   The Node type preset omits the DOM library that declares `WebAssembly`, and this package's
 *   declarations type-check without it, so the loader types the members it uses itself.
 *   Every runtime this package targets defines the global.
 *   The read here does no WebAssembly work.
 */

import type { Exports } from "#runtime/abi"

/**
 * A compiled WebAssembly module.
 */
export interface CompiledModule {
	readonly [Symbol.toStringTag]: string
}

/**
 * The bytes a module compiles from.
 */
export type ModuleBytes = Uint8Array<ArrayBuffer>

/**
 * The members of `WebAssembly` the loader uses.
 *
 * An instance of the engine module exposes the engine's exports.
 */
export interface WebAssemblyAPI {
	Module: new (bytes: ModuleBytes) => CompiledModule
	Instance: new (module: CompiledModule, imports: object) => { readonly exports: Exports }
	RuntimeError: new (message?: string) => Error
	compile(bytes: ModuleBytes): Promise<CompiledModule>
}

/**
 * The runtime's `WebAssembly` global.
 */
export const wasm: WebAssemblyAPI = Reflect.get(globalThis, "WebAssembly")
