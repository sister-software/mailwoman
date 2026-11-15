// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The C ABI `crates/recognize-wasm` exports.
 */

/**
 * The ABI version this loader implements.
 * It equals `ABI_VERSION` in `crates/recognize-wasm`.
 */
export const ABI_VERSION = 1

/**
 * The exports of the engine module.
 */
export interface Exports {
	memory: { readonly buffer: ArrayBuffer }
	rcg_abi_version(): number
	rcg_alloc(length: number): number
	rcg_dealloc(pointer: number, length: number): void
	rcg_error_code(): number
	rcg_error_ptr(): number
	rcg_error_len(): number
	rcg_load(pointer: number, length: number, hashPointer: number, hashLength: number): number
	rcg_recognize(pointer: number, length: number, mask: number): number
	rcg_result_ptr(): number
}

/**
 * The error codes `rcg_error_code` answers, equal to `recognize_wasm::code`.
 */
export const ErrorCode = {
	Artifact: 1,
	DeclarationsHash: 2,
	InputTooLong: 3,
	NotUTF8: 4,
	Search: 5,
	Argument: 6,
} as const

/**
 * The most families one instance loads, equal to `MAX_FAMILIES` in `crates/recognize-wasm`.
 */
export const MAX_FAMILIES = 32
