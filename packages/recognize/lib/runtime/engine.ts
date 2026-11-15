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

import type { AnyFamily, Rejected, Unvalidated, Validated } from "#family"
import { offsetMap } from "#offsets"
import { ErrorCode, MAX_FAMILIES, RECORD_WORDS, Status } from "#runtime/abi"
import { RecognizeArtifactError, RecognizeError } from "#runtime/errors"
import { type Instance, trapped } from "#runtime/state"
import type { Trace, TraceSpan } from "#trace"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/**
 * One recognition as the loader returns it, before a recognizer gives it the composed families' types.
 * Offsets are UTF-16 code units.
 */
export interface LooseRecognition {
	readonly kind: string
	readonly family: string
	readonly start: number
	readonly end: number
	readonly text: string
	readonly validation: Unvalidated | Validated<unknown> | Rejected
}

/**
 * The outcome of a shape that declares no validator.
 * Every such recognition shares it.
 */
const UNVALIDATED: Unvalidated = Object.freeze({ status: "unvalidated" })

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

		const tableLength = exports.rcg_shapes(handle)

		if (tableLength < 0) throw new RecognizeError(lastErrorMessage(instance))

		const table = decoder.decode(memoryBytes(instance, exports.rcg_json_ptr(), tableLength))

		instance.tables[handle] = {
			id: family.id,
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- a family's table is a few dozen short shape IDs, read once at load
			shapes: table.split("\n"),
		}

		instance.families.set(family.id, { handle, declarationsHash: family.declarationsHash })

		return handle
	} catch (error) {
		throw trapped(error)
	}
}

/**
 * Recognizes `text` over the families whose handle bit is set in `mask`.
 *
 * One call into the engine returns every recognition as a run of fixed-width records,
 * read in place from linear memory.
 * Only a validated payload or a rejection is JSON, and only that text is decoded and parsed.
 *
 * Text whose encoding is as long as the text is ASCII, and its byte offsets are its code-unit offsets.
 */
export function recognizeText(instance: Instance, text: string, mask: number): LooseRecognition[] {
	try {
		const { exports } = instance
		// A code unit encodes to at most three bytes.
		const capacity = text.length * 3
		const pointer = reserve(instance, capacity)
		const { written } = encoder.encodeInto(text, memoryBytes(instance, pointer, capacity))
		const count = exports.rcg_recognize(pointer, written, mask)

		if (count < 0) {
			const message = lastErrorMessage(instance)
			const code = exports.rcg_error_code()

			if (code === ErrorCode.InputTooLong) throw new RangeError(message)

			throw new RecognizeError(message)
		}

		return readRecognitions(instance, text, written, count)
	} catch (error) {
		throw trapped(error)
	}
}

/**
 * Traces `text` over the families whose handle bit is set in `mask`, and explains the shapes in `explain`.
 *
 * This is the only call that reaches `rcg_trace`, so a call that didn't ask for a trace builds none.
 * It searches again, so a caller reads the recognitions first: the call overwrites their JSON.
 * Every span comes back in UTF-16 code units.
 */
export function traceText(instance: Instance, text: string, mask: number, explain: readonly string[]): Trace[] {
	try {
		const { exports } = instance
		const capacity = text.length * 3
		const pointer = reserve(instance, capacity)
		const { written } = encoder.encodeInto(text, memoryBytes(instance, pointer, capacity))
		const names = encoder.encode(explain.join("\n"))
		const namesPointer = exports.rcg_alloc(names.byteLength)

		let length: number

		try {
			memoryBytes(instance, namesPointer, names.byteLength).set(names)
			length = exports.rcg_trace(pointer, written, mask, namesPointer, names.byteLength)
		} finally {
			exports.rcg_dealloc(namesPointer, names.byteLength)
		}

		if (length < 0) {
			const message = lastErrorMessage(instance)

			if (exports.rcg_error_code() === ErrorCode.InputTooLong) throw new RangeError(message)

			throw new RecognizeError(message)
		}

		// The engine writes the document in the shape of `Trace` with UTF-8 byte spans.
		// oxlint-disable-next-line no-restricted-properties -- the engine writes the document, and a parse failure is a bug to throw
		const traces = JSON.parse(decoder.decode(memoryBytes(instance, exports.rcg_json_ptr(), length))) as Trace[]

		if (written === text.length) {
			return traces
		}

		const map = offsetMap(text, written)
		const convert = (span: TraceSpan): TraceSpan => ({ start: map.toUTF16(span.start), end: map.toUTF16(span.end) })

		return traces.map((trace) => ({
			...trace,
			...(trace.span && { span: convert(trace.span) }),
			steps: trace.steps.map((step) => ({ ...step, ...(step.span && { span: convert(step.span) }) })),
		}))
	} catch (error) {
		throw trapped(error)
	}
}

/**
 * Reads the `count` records the last `rcg_recognize` call left in linear memory,
 * for a text of `byteLength` bytes.
 */
export function readRecognitions(
	instance: Instance,
	text: string,
	byteLength: number,
	count: number
): LooseRecognition[] {
	const recognitions: LooseRecognition[] = []

	if (count === 0) return recognitions

	const { exports, tables } = instance
	const { buffer } = exports.memory
	const records = new Uint32Array(buffer, exports.rcg_result_ptr(), count * RECORD_WORDS)
	const map = byteLength === text.length ? null : offsetMap(text, byteLength)
	const jsonPointer = exports.rcg_json_ptr()

	for (let index = 0; index < records.length; index += RECORD_WORDS) {
		const table = tables[records[index]!]!
		const start = map ? map.toUTF16(records[index + 2]!) : records[index + 2]!
		const end = map ? map.toUTF16(records[index + 3]!) : records[index + 3]!
		const status = records[index + 4]!
		let validation: LooseRecognition["validation"] = UNVALIDATED

		if (status !== Status.Unvalidated) {
			const document = decoder.decode(new Uint8Array(buffer, jsonPointer + records[index + 5]!, records[index + 6]!))

			// The library imports no workspace package, so a bundle of it holds no Node module and no unrelated code.
			// oxlint-disable-next-line no-restricted-properties -- the engine writes the document, and a parse failure is a bug to throw
			const parsed: unknown = JSON.parse(document)

			validation =
				status === Status.Validated
					? { status: "validated", payload: parsed }
					: { status: "rejected", rejection: parsed as Rejected["rejection"] }
		}

		recognitions.push({
			kind: table.shapes[records[index + 1]!]!,
			family: table.id,
			start,
			end,
			text: text.slice(start, end),
			validation,
		})
	}

	return recognitions
}
