// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The calls into the engine module: loading a family's artifact and recognizing text.
 *
 *   A family's artifact is data.
 *   It is written into the module's linear memory after instantiation,
 *   so no artifact is part of the binary.
 *
 *   A trap in any call poisons the instance, and the caller sees the public error.
 */

import type { AnyFamily } from "#family"
import { ErrorCode, MAX_FAMILIES } from "#runtime/abi"
import { RecognizeArtifactError, RecognizeError } from "#runtime/errors"
import { type Instance, trapped } from "#runtime/state"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/**
 * One recognition as the engine's result document spells it, with UTF-8 byte offsets.
 */
export interface RawRecognition {
	family: string
	shape: string
	start: number
	end: number
	validation:
		| { status: "unvalidated" }
		| { status: "validated"; payload: unknown }
		| { status: "rejected"; rejection: { code: string; capture: string | null; message: string } }
}

/**
 * The engine's result document.
 */
export interface RawResult {
	recognitions: RawRecognition[]
	fields: Record<string, unknown>
}

function memoryBytes(instance: Instance, pointer: number, length: number): Uint8Array {
	// `memory.buffer` is read again at every use, because memory growth detaches the previous buffer.
	return new Uint8Array(instance.exports.memory.buffer, pointer, length)
}

function lastErrorMessage(instance: Instance): string {
	const length = instance.exports.rcg_error_len()

	return decoder.decode(memoryBytes(instance, instance.exports.rcg_error_ptr(), length))
}

/**
 * Reserves at least `length` bytes of staging memory and returns its address.
 */
function reserve(instance: Instance, length: number): number {
	const { staging, exports } = instance

	if (length > staging.length) {
		if (staging.length) {
			exports.rcg_dealloc(staging.pointer, staging.length)
		}

		const wanted = Math.max(length, 512)

		staging.pointer = exports.rcg_alloc(wanted)
		staging.length = wanted
	}

	return staging.pointer
}

/**
 * Loads a family into the instance, once.
 *
 * A second call for the same family returns the handle it got, and refuses a
 * declaration whose hash differs from the one the first load used.
 */
export function loadFamily(instance: Instance, family: AnyFamily): number {
	const known = instance.families.get(family.id)

	if (known) {
		if (known.declarationsHash !== family.declarationsHash) {
			throw new RecognizeArtifactError(
				`family ${family.id} is already loaded with declarations hash ${known.declarationsHash}, ` +
					`and this declaration has ${family.declarationsHash}`
			)
		}

		return known.handle
	}

	if (instance.families.size >= MAX_FAMILIES) {
		throw new RecognizeError(`an engine instance loads at most ${MAX_FAMILIES} families`)
	}

	try {
		const artifact = family.artifact()
		const hash = encoder.encode(family.declarationsHash)
		const { exports } = instance
		const artifactPointer = exports.rcg_alloc(artifact.byteLength)

		memoryBytes(instance, artifactPointer, artifact.byteLength).set(artifact)

		const hashPointer = exports.rcg_alloc(hash.byteLength)

		memoryBytes(instance, hashPointer, hash.byteLength).set(hash)

		const handle = exports.rcg_load(artifactPointer, artifact.byteLength, hashPointer, hash.byteLength)

		exports.rcg_dealloc(artifactPointer, artifact.byteLength)
		exports.rcg_dealloc(hashPointer, hash.byteLength)

		if (handle < 0) {
			const message = lastErrorMessage(instance)

			throw new RecognizeArtifactError(
				exports.rcg_error_code() === ErrorCode.DeclarationsHash
					? `the artifact of family ${family.id} was not built from the declarations it is loaded beside: ${message}`
					: `the engine refused the artifact of family ${family.id}: ${message}`
			)
		}

		instance.families.set(family.id, { handle, declarationsHash: family.declarationsHash })

		return handle
	} catch (error) {
		throw trapped(error)
	}
}

/**
 * Recognizes `text` over the families whose handle bit is set in `mask`.
 */
export function recognizeRaw(
	instance: Instance,
	text: string,
	mask: number
): { result: RawResult; byteLength: number } {
	try {
		const { exports } = instance
		// A code unit encodes to at most three bytes.
		const pointer = reserve(instance, text.length * 3)
		const { written } = encoder.encodeInto(text, memoryBytes(instance, pointer, text.length * 3))
		const length = exports.rcg_recognize(pointer, written, mask)

		if (length < 0) {
			const message = lastErrorMessage(instance)
			const code = exports.rcg_error_code()

			if (code === ErrorCode.InputTooLong) throw new RangeError(message)

			throw new RecognizeError(message)
		}

		const document = decoder.decode(memoryBytes(instance, exports.rcg_result_ptr(), length))

		// The library imports no workspace package, so a bundle of it holds no Node module and no unrelated code.
		// oxlint-disable-next-line no-restricted-properties -- the engine writes the document, and a parse failure is a bug to throw
		return { result: JSON.parse(document) as RawResult, byteLength: written }
	} catch (error) {
		throw trapped(error)
	}
}
