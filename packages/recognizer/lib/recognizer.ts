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

import type { AnyFamily, FieldsOf, KindsOf, RecognitionsOf } from "#family"
import { loadFamily, type PrefixStatus, prefixStatuses, recognizeText, traceText } from "#runtime/engine"
import { RecognizerCompositionError } from "#runtime/errors"
import { type Instance, ready } from "#runtime/state"
import { type KnownFormatsBinding, structureFields } from "#runtime/structure"
import type { Trace, TraceOptions } from "#trace"

/**
 * Reads what a known-formats family's metadata holds for each of its shapes.
 *
 * The metadata holds, for each shape ID, a `format`, a `tokens` count of 1 or 2 and a `confidence`,
 * or no entry for a shape that's no format, and the family's `poBox` name and confidence.
 */
function knownFormatsBinding(family: AnyFamily, handle: number, shapeIDs: readonly string[]): KnownFormatsBinding {
	const metadata = family.metadata as
		| {
				shapes?: Record<string, { format?: unknown; tokens?: unknown; confidence?: unknown }>
				family?: { poBox?: { format?: unknown; confidence?: unknown } }
		  }
		| undefined

	const poBox = metadata?.family?.poBox

	if (typeof poBox?.format !== "string" || typeof poBox.confidence !== "number") {
		throw new RecognizerCompositionError(
			`family ${family.id} fills knownFormats and declares no poBox name and confidence`
		)
	}

	const shapes = shapeIDs.map((id): KnownFormatsBinding["shapes"][number] => {
		const entry = metadata?.shapes?.[id]

		if (!entry || typeof entry.format !== "string") return null

		const tokens = entry.tokens === 1 ? 1 : entry.tokens === 2 ? 2 : null

		if (tokens === null || typeof entry.confidence !== "number") {
			throw new RecognizerCompositionError(`family ${family.id}: shape ${id} declares no token count and confidence`)
		}

		return { format: entry.format, tokens, confidence: entry.confidence }
	})

	return { handle, shapes, poBox: { format: poBox.format, confidence: poBox.confidence } }
}

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
export interface RecognizerResult<F extends readonly AnyFamily[]> {
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
export interface TracedRecognizerResult<F extends readonly AnyFamily[]> extends RecognizerResult<F> {
	/**
	 * One trace per recognition, in the order of `recognitions`, then one per shape
	 * listed in `trace.explain` that a composed family declares.
	 */
	readonly traces: readonly Trace[]
}

/**
 * The options of a call.
 */
export interface RecognizerOptions {
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
	recognize(text: string, options?: { readonly trace?: false }): RecognizerResult<F>
	recognize(text: string, options: { readonly trace: true | TraceOptions }): TracedRecognizerResult<F>
	recognize(text: string, options?: RecognizerOptions): RecognizerResult<F> | TracedRecognizerResult<F>
	/**
	 * Reads `text` as the beginning of a whole-input match of each shape, for every shape of
	 * every composed family that a search reports, in the engine's order of family and shape.
	 *
	 * It loads the engine on the first call, as `recognize` does, and is synchronous.
	 * A family that fills a field and reports no recognition is left out.
	 */
	prefixStatus(text: string): ReadonlyArray<ShapePrefixStatus<F>>
}

/**
 * One shape's prefix status for a text.
 * See {@link PrefixStatus} for the meaning of each status.
 */
export interface ShapePrefixStatus<F extends readonly AnyFamily[]> {
	readonly kind: KindsOf<F>
	readonly family: string
	readonly status: PrefixStatus
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

	const readers = families.filter((family) => family.fields)
	const known = readers.filter((family) => family.fields === "knownFormats")

	if (known.length > 1) {
		throw new RecognizerCompositionError(
			`createRecognizer: ${known.map((family) => family.id).join(" and ")} both fill knownFormats; compose one`
		)
	}

	if (known.length && !readers.some((family) => family.fields === "structure")) {
		throw new RecognizerCompositionError(
			`createRecognizer: family ${known[0]!.id} fills knownFormats from the tokens of the structure family, ` +
				"and the composition has no structure family"
		)
	}

	let bound: { instance: Instance; mask: number; structure: number; formats: KnownFormatsBinding | undefined } | null =
		null

	function bind(): NonNullable<typeof bound> {
		const instance = ready()

		if (bound?.instance !== instance) {
			let mask = 0
			let structure = -1
			let formats: KnownFormatsBinding | undefined

			for (const family of families) {
				const handle = loadFamily(instance, family)

				// A family with a field reader reports no recognitions, so a search leaves the knownFormats family out.
				if (family.fields !== "knownFormats") {
					mask |= 1 << handle
				}

				if (family.fields === "structure") {
					structure = handle
				}

				if (family.fields === "knownFormats") {
					formats = knownFormatsBinding(family, handle, instance.tables[handle]!.shapes)
				}
			}

			bound = { instance, mask: mask >>> 0, structure, formats }
		}

		return bound
	}

	function prefixStatus(text: string): ReadonlyArray<ShapePrefixStatus<F>> {
		const { instance, mask } = bind()

		return trusted<ReadonlyArray<ShapePrefixStatus<F>>>(prefixStatuses(instance, text, mask))
	}

	function recognize(text: string, options?: { readonly trace?: false }): RecognizerResult<F>
	function recognize(text: string, options: { readonly trace: true | TraceOptions }): TracedRecognizerResult<F>
	function recognize(text: string, options?: RecognizerOptions): RecognizerResult<F> | TracedRecognizerResult<F>

	function recognize(text: string, options?: RecognizerOptions): RecognizerResult<F> | TracedRecognizerResult<F> {
		const binding = bind()
		const { instance } = binding

		// The recognitions are read out of linear memory before the structure call overwrites the records.
		const recognitions = recognizeText(instance, text, binding.mask)

		const result: RecognizerResult<F> = {
			recognitions: trusted<ReadonlyArray<RecognitionsOf<F>>>(recognitions),
			fields: trusted<FieldsOf<F>>(
				binding.structure < 0 ? {} : structureFields(instance, text, binding.structure, binding.formats)
			),
		}

		const trace = options?.trace

		// The default call returns here, and no code below this line runs for it.
		if (!trace) return result

		const explain = trace === true ? [] : (trace.explain ?? [])

		return { ...result, traces: traceText(instance, text, binding.mask, explain) }
	}

	return { families, recognize, prefixStatus }
}
