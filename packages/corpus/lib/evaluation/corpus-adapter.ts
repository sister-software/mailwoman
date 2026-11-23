// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * A corpus adapter over an evaluation source's record reader.
 *
 *   The adapter and the evaluation source read the publisher's file through one function,
 *   so a fix to the reader reaches both.
 *   A record holds only the address components the reader chose, never the publisher's
 *   name for the site or the organization, so a row cannot join an address to a
 *   person a small charity's name could identify.
 *
 *   The row is rendered by the country's codex layout, and its id is content-addressed
 *   over the rendered components.
 *   Two records at one address are one row, and the second is counted
 *   under {@linkcode EvaluationAdapterRefusal.Duplicate}.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import type { PathBuilderLike } from "path-ts"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import type { EvaluationRecordReading, EvaluationSource } from "#evaluation/source"
import { type AddressRole, type CanonicalRow, type CorpusAdapter, countDropped, SurfaceOrigin } from "#types"

/**
 * Why an address record the reader admitted yielded no corpus row.
 */
export const EvaluationAdapterRefusal = {
	/**
	 * The country's layout doesn't print every component the record holds.
	 */
	Unrenderable: "row:unrenderable",
	/**
	 * Another record already produced this exact row.
	 */
	Duplicate: "row:duplicate",
} as const

/**
 * What an adapter over an evaluation source's reader declares beyond the source itself.
 */
export interface EvaluationCorpusAdapterSpec {
	/**
	 * The adapter id, written as a literal `*_ADAPTER_ID` constant in the adapter's module
	 * so the `wire-identifiers` check can read it.
	 * It must equal the evaluation source's id.
	 */
	id: string
	/**
	 * The evaluation source whose id, country and license the adapter stamps on every row.
	 */
	source: Pick<EvaluationSource, "id" | "country" | "license">
	/**
	 * The `SourceRegister` value naming the publication.
	 */
	register: string
	/**
	 * The adapter stamps this BCP 47 locale on every row.
	 */
	locale: string
	addressRole: AddressRole
	description: string
	/**
	 * The record reader the evaluation source also calls, over the adapter's input file.
	 */
	read(path: PathBuilderLike): AsyncIterable<EvaluationRecordReading>
}

/**
 * One reader's verdict as a corpus row, or the reason it yields none.
 */
export function evaluationRecordRow(
	spec: Pick<EvaluationCorpusAdapterSpec, "source" | "locale">,
	reading: EvaluationRecordReading
): { readonly admitted: CanonicalRow } | { readonly refused: string } {
	if ("refused" in reading) return reading

	const { country } = spec.source
	const rendered = formatAddressRow(reading.components, country, { singleLine: true })

	if (!rendered || rendered.unplaced.length) return { refused: EvaluationAdapterRefusal.Unrenderable }

	return {
		admitted: {
			raw: rendered.raw,
			components: rendered.components,
			country,
			locale: spec.locale,
			source: spec.source.id,
			source_id: stableSourceID(spec.source.id, rendered.components),
			license: spec.source.license,
		},
	}
}

/**
 * A corpus adapter, under the evaluation source's id, that emits each record its reader admits.
 *
 * @throws When `spec.id` differs from the evaluation source's id.
 */
export function createEvaluationCorpusAdapter(spec: EvaluationCorpusAdapterSpec): CorpusAdapter {
	const { id, country, license } = spec.source

	if (spec.id !== id) {
		throw new Error(`adapter id ${spec.id} differs from its evaluation source's id ${id}`)
	}

	return {
		id,
		defaultLicense: license,
		addressRole: spec.addressRole,
		register: spec.register,
		surface: SurfaceOrigin.Rendered,
		description: spec.description,

		async *rows(opts) {
			if (opts.country && opts.country !== country) {
				throw new UnsupportedCountryError(id, [country], opts.country)
			}

			const seen = new Set<string>()
			let emitted = 0

			for await (const reading of spec.read(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (typeof opts.limit === "number" && emitted >= opts.limit) break

				const row = evaluationRecordRow(spec, reading)

				if ("refused" in row) {
					countDropped(opts, row.refused)

					continue
				}

				if (seen.has(row.admitted.source_id)) {
					countDropped(opts, EvaluationAdapterRefusal.Duplicate)

					continue
				}

				seen.add(row.admitted.source_id)

				yield row.admitted

				emitted++
			}
		},
	}
}
