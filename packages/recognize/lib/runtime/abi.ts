// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The C ABI `crates/recognize-wasm` exports.
 */

/**
 * The ABI version this loader implements.
 * It equals `ABI_VERSION` in `crates/recognize-wasm`.
 */
export const ABI_VERSION = 4

/**
 * The words before the first token of a structure result, equal to `STRUCTURE_HEADER_WORDS`
 * in `crates/recognize-wasm`: the token, segment and region counts, then the
 * codepoint count of each of the ten scripts.
 */
export const STRUCTURE_HEADER_WORDS = 13

/**
 * The words of one token in a structure result: start, end, and the class code
 * with the script code in the next byte.
 */
export const TOKEN_WORDS = 3

/**
 * The words of one segment in a structure result: start, end and the separator code.
 */
export const SEGMENT_WORDS = 3

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
	/**
	 * Traces the text over the families in `mask`, and the shapes in the
	 * newline-joined list at `explainPointer`.
	 *
	 * Returns the byte length of the JSON text of the traces at `rcg_json_ptr`, or -1.
	 * It overwrites the JSON `rcg_recognize` wrote.
	 */
	rcg_trace(pointer: number, length: number, mask: number, explainPointer: number, explainLength: number): number
	/**
	 * Computes the structural fields of the text with the family whose handle is `family`.
	 *
	 * Returns the number of words written at `rcg_result_ptr`, or -1.
	 * It overwrites the recognition records.
	 */
	rcg_structure(pointer: number, length: number, family: number): number
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
