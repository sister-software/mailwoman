/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `synth-po-box`: PO box / PMB / Apartado / BP synthesizer adapter.
 *
 * A PO box delivery line is mutually exclusive with a street line (USPS Pub 28 / DMM 508), so rows
 * are generated fresh from a tuple rather than by mutating a street row.
 */

import { tryParsingJSON } from "@mailwoman/core/json"
import { makeLcg } from "@mailwoman/core/random"
import { TextSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import {
	poBoxTemplateLocale,
	REGION_OPTIONAL_LOCALES,
	synthesizeMilitaryPoBoxRow,
	synthesizePoBoxRow,
	type PoBoxBaseTuple,
} from "#synthesizers/po-box"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id stamped into every row this adapter emits, so a corpus record traces back to its dataset.
 */
export const SYNTH_PO_BOX_ADAPTER_ID = "synth-po-box"
/**
 * License for the synthetic PO-box rows, which inherit the terms of the real tuples they are derived from.
 */
export const SYNTH_PO_BOX_LICENSE = "Synthetic — derived from CC-BY / public-domain input tuples"

export interface PoBoxInputRow extends PoBoxBaseTuple {
	street?: string
	houseNumber?: string
}

export interface SynthPoBoxAdapterOptions {
	/**
	 * How many PO box variants to emit per input tuple, each picking a different leader
	 * (and possibly a different number or noise level); default 1.
	 */
	variantsPerInput?: number
	/**
	 * Probability (0..1) of emitting a PMB-with-street variant when the input has a street
	 * and the locale supports PMB; default 0.15.
	 */
	pmbRatio?: number
	/**
	 * Deterministic seed for reproducible synthesis; default `Date.now()`.
	 */
	seed?: number
	/**
	 * Probability (0..1) per input tuple of additionally emitting one self-contained US
	 * military/diplomatic PO-box row, so military volume scales with the input stream; default 0.
	 */
	militaryRatio?: number
}

export function createSynthPoBoxAdapter(opts: SynthPoBoxAdapterOptions = {}): CorpusAdapter {
	const variantsPerInput = opts.variantsPerInput ?? 1
	const pmbRatio = opts.pmbRatio ?? 0.15
	const militaryRatio = opts.militaryRatio ?? 0

	return {
		id: SYNTH_PO_BOX_ADAPTER_ID,
		defaultLicense: SYNTH_PO_BOX_LICENSE,
		addressRole: AddressRole.Mailing,
		// No register asserts these boxes exist; the rows teach the shape of a post-office box line.
		register: null,
		surface: SurfaceOrigin.Invented,
		description:
			"Synthetic PO box / PMB / Apartado / Boîte Postale rows. Consumes JSONL of (locality, region, postcode, country) tuples and emits locale-appropriate PO box variants.",

		async *rows(options: AdapterOptions): AsyncIterable<CanonicalRow> {
			const random = makeLcg(opts.seed ?? Date.now())

			// A non-throwing parse (the `skipped++` below) tolerates malformed rows,
			// unlike `JSONSpliterator`, which would throw on the first bad line.
			const lines = TextSpliterator.fromAsync(options.inputPath)

			let emitted = 0
			let skipped = 0
			let militarySeq = 0

			for await (const line of lines) {
				if (options.signal?.aborted) break

				if (options.limit !== undefined && emitted >= options.limit) break

				const trimmed = line.trim()

				if (!trimmed) continue

				const input = tryParsingJSON<PoBoxInputRow>(trimmed)

				if (input === null) {
					skipped++

					continue
				}

				// Region is required except for region-less locales (NZ: `Private Bag 12, Auckland 1010` has
				// no region token), where the guard must not discard the tuple as missing region.
				const regionOptional = input.country ? REGION_OPTIONAL_LOCALES.has(poBoxTemplateLocale(input.country)) : false

				if (!input.locality || !input.postcode || !input.country || (!input.region && !regionOptional)) {
					skipped++

					continue
				}

				if (options.country && options.country !== input.country) continue

				for (let v = 0; v < variantsPerInput; v++) {
					const synth = synthesizePoBoxRow(input, { random, pmbRatio })

					if (!synth) continue

					// Include `v` in the locality slot to vary the digest across variants;
					// `stableSourceID` only accepts `ComponentTag` keys.
					const sourceID = stableSourceID(SYNTH_PO_BOX_ADAPTER_ID, {
						locality: `${input.locality}#${v}`,
						region: input.region,
						postcode: input.postcode,
						country: input.country,
					})

					yield {
						raw: synth.raw,
						components: synth.components,
						country: input.country,
						locale: synth.locale,
						source: SYNTH_PO_BOX_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: SYNTH_PO_BOX_LICENSE,
					}

					emitted++

					if (options.limit !== undefined && emitted >= options.limit) break
				}

				// US military/diplomatic rows are self-contained and off by default, so the default random
				// stream and output stay byte-identical; they are US-only and count against `limit`.
				const militaryAllowed = !options.country || options.country === "US"

				if (
					militaryRatio > 0 &&
					militaryAllowed &&
					(options.limit === undefined || emitted < options.limit) &&
					random() < militaryRatio
				) {
					const mil = synthesizeMilitaryPoBoxRow({ random })

					const sourceID = stableSourceID(SYNTH_PO_BOX_ADAPTER_ID, {
						po_box: `${mil.components.po_box}#mil${militarySeq++}`,
						locality: mil.components.locality!,
						region: mil.components.region!,
						postcode: mil.components.postcode!,
					})

					yield {
						raw: mil.raw,
						components: mil.components,
						country: "US",
						locale: mil.locale,
						source: SYNTH_PO_BOX_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: SYNTH_PO_BOX_LICENSE,
					}

					emitted++
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const synthPoBoxAdapter = createSynthPoBoxAdapter()
