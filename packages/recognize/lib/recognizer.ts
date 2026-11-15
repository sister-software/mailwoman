// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `createRecognizer`: composes families into one synchronous recognizer.
 *
 *   A new recognizer loads no engine.
 *   The first `recognize` call instantiates the engine and loads the composed families' artifacts.
 *   Later calls reuse them.
 *
 *   Several recognizers share one engine instance, and each searches only its own families.
 */

import type { AnyFamily, FieldsOf, RecognitionsOf } from "#family"
import { loadFamily, recognizeText, traceText } from "#runtime/engine"
import { type Instance, ready } from "#runtime/state"
import { structureFields } from "#runtime/structure"
import type { Trace, TraceOptions } from "#trace"

/**
 * Gives the engine's JSON the types the composed families' generated declarations promise.
 *
 * The engine's result records name the shapes the declarations list.
 * The loader has already checked that the artifact was built from those declarations.
 *
 * This is the one place the result takes its static type on trust.
 */
function trusted<T>(value: unknown): T {
	return value as T
}

/**
 * The result of one recognition call.
 */
export interface RecognizeResult<F extends readonly AnyFamily[]> {
	/**
	 * Every candidate span of every composed family, sorted by start, end, family and shape.
	 * Offsets are UTF-16 code units.
	 */
	readonly recognitions: ReadonlyArray<RecognitionsOf<F>>
	/**
	 * The fields the composed families add: the `structure` family's structural fields.
	 */
	readonly fields: FieldsOf<F>
}

/**
 * The result of a call that asked for traces: the same recognitions and fields, and the traces.
 */
export interface TracedRecognizeResult<F extends readonly AnyFamily[]> extends RecognizeResult<F> {
	/**
	 * One trace per recognition, in the order of `recognitions`, then one per shape
	 * listed in `trace.explain` that a composed family declares.
	 */
	readonly traces: readonly Trace[]
}

/**
 * The options of a call.
 */
export interface RecognizeOptions {
	/**
	 * Asks for traces.
	 *
	 * `true` traces each recognition, and an object also names shapes to explain.
	 * Absent or `false`, the call builds no trace and its result has no `traces` property.
	 */
	readonly trace?: boolean | TraceOptions
}

/**
 * A recognizer over the families it was created with.
 */
export interface Recognizer<F extends readonly AnyFamily[]> {
	readonly families: F
	/**
	 * Recognizes `text`.
	 *
	 * The first call instantiates the engine synchronously, and every call is synchronous.
	 *
	 * The result type of a call without the `trace` option is the same as it was before traces existed.
	 * A call with `trace: true` or a `TraceOptions` object returns the traces as well.
	 */
	recognize(text: string, options?: { readonly trace?: false }): RecognizeResult<F>
	recognize(text: string, options: { readonly trace: true | TraceOptions }): TracedRecognizeResult<F>
	recognize(text: string, options?: RecognizeOptions): RecognizeResult<F> | TracedRecognizeResult<F>
}

/**
 * Composes families into a recognizer.
 *
 * The result type of its recognitions is the union of the families' kinds.
 *
 * Synchronous, and it loads no engine.
 * A repeated family ID throws.
 */
export function createRecognizer<const F extends readonly AnyFamily[]>(families: F): Recognizer<F> {
	const seen = new Set<string>()

	for (const family of families) {
		if (seen.has(family.id)) throw new TypeError(`createRecognizer: family ${family.id} is listed twice`)

		seen.add(family.id)
	}

	let bound: { instance: Instance; mask: number; structure: number } | null = null

	function recognize(text: string, options?: { readonly trace?: false }): RecognizeResult<F>
	function recognize(text: string, options: { readonly trace: true | TraceOptions }): TracedRecognizeResult<F>
	function recognize(text: string, options?: RecognizeOptions): RecognizeResult<F> | TracedRecognizeResult<F>

	function recognize(text: string, options?: RecognizeOptions): RecognizeResult<F> | TracedRecognizeResult<F> {
		const instance = ready()

		if (bound?.instance !== instance) {
			let mask = 0
			let structure = -1

			for (const family of families) {
				const handle = loadFamily(instance, family)

				mask |= 1 << handle

				if (family.fields === "structure") {
					structure = handle
				}
			}

			bound = { instance, mask: mask >>> 0, structure }
		}

		// The recognitions are read out of linear memory before the structure call overwrites the records.
		const recognitions = recognizeText(instance, text, bound.mask)

		const result: RecognizeResult<F> = {
			recognitions: trusted<ReadonlyArray<RecognitionsOf<F>>>(recognitions),
			fields: trusted<FieldsOf<F>>(bound.structure < 0 ? {} : structureFields(instance, text, bound.structure)),
		}

		const trace = options?.trace

		// The default call returns here, and no code below this line runs for it.
		if (!trace) return result

		const explain = trace === true ? [] : (trace.explain ?? [])

		return { ...result, traces: traceText(instance, text, bound.mask, explain) }
	}

	return { families, recognize }
}
