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
import { loadFamily, recognizeText } from "#runtime/engine"
import { type Instance, ready } from "#runtime/state"

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
	 * The fields the composed families add.
	 * No family declares fields yet.
	 */
	readonly fields: FieldsOf<F>
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
	 */
	recognize(text: string): RecognizeResult<F>
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

	let bound: { instance: Instance; mask: number } | null = null

	return {
		families,
		recognize(text) {
			const instance = ready()

			if (bound?.instance !== instance) {
				let mask = 0

				for (const family of families) {
					mask |= 1 << loadFamily(instance, family)
				}

				bound = { instance, mask: mask >>> 0 }
			}

			return {
				recognitions: trusted<ReadonlyArray<RecognitionsOf<F>>>(recognizeText(instance, text, bound.mask)),
				fields: trusted<FieldsOf<F>>({}),
			}
		},
	}
}
