// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The C ABI `crates/recognize-wasm` exports.
 */

/**
 * The ABI version this loader implements.
 * It equals `ABI_VERSION` in `crates/recognize-wasm`.
 */
export const ABI_VERSION = 2

/**
 * The words of one result record, equal to `RECORD_WORDS` in `crates/recognize-wasm`.
 *
 * In order: the family's handle, the shape's position in the family's shape table, the start
 * and the end as UTF-8 byte offsets, the status, and the offset and the length of the record's JSON.
 */
export const RECORD_WORDS = 7

/**
 * The status words of a result record, equal to `recognize_wasm::status`.
 */
export const Status = {
	Unvalidated: 0,
	Validated: 1,
	Rejected: 2,
} as const

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
	rcg_shapes(family: number): number
	/**
	 * Returns the number of result records, or -1.
	 */
	rcg_recognize(pointer: number, length: number, mask: number): number
	rcg_result_ptr(): number
	rcg_json_ptr(): number
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
