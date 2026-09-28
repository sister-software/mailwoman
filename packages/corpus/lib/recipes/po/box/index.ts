/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `po-box` recipe, synthetic PO box rows: tuples → {@link synthesizePoBoxRow} → aligned
 *   LabeledRow, plus optional self-contained US military/diplomatic rows at `--military-ratio`.
 *   Region is required except for region-less locales (NZ).
 */

import { makeLcg } from "@mailwoman/core/utils"

import {
	alignAndWrite,
	readTuples,
	recipeSourceID,
	SYNTHETIC_TUPLE_LICENSE as LICENSE,
	type CorpusRecipe,
} from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { synthesizeMilitaryPoBoxRow, synthesizePoBoxRow, type PoBoxBaseTuple } from "#synthesizers/po-box"
import { SurfaceOrigin } from "#types"

/**
 * The box number is drawn rather than read, so no register asserts that this box exists.
 *
 * The locality, region and postcode around it come from the `--input` tuples.
 * The row as a whole identifies no published record.
 * The register field carries null for that reason.
 */
const PO_BOX_PROVENANCE = {
	register: null,
	surface: SurfaceOrigin.Invented,
	// An invented row has no underlying record to name.
	baseSourceID: null,
}

/**
 * Recipe registered with the corpus builder.
 *
 * See the file header for the parse behaviour this recipe exercises.
 * See `description` below for the surface form it generates.
 */
export const poBoxRecipe: CorpusRecipe = {
	name: "po-box",
	description: "PO box rows: tuples → synthesizePoBoxRow (+ optional US military/diplomatic rows)",
	mode: "tuples",
	options: [
		{ flag: "--pmb-ratio <p>", description: "P(private-mailbox layout). Default 0.15" },
		{ flag: "--military-ratio <p>", description: "P(emit one US military/diplomatic row per input, #517). Default 0" },
	],
	async run(opts, write) {
		if (!opts.input) throw new Error("po-box recipe requires --input <tuples.jsonl>")
		const random = makeLcg(opts.seed)
		const pmbRatio = opts.pmbRatio ?? 0.15
		const militaryRatio = opts.militaryRatio ?? 0
		// `--source-name` gives an output built for one class its own source label and its own reps per row.
		// A military-only output (`--variants 0 --military-ratio 1`) would otherwise be
		// indistinguishable from the leader-template rows in the mixture.
		// The two classes carry different weights.
		const source = opts.sourceName ?? defaultRecipeSource("synth-po-box")
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const tuple of readTuples(opts.input)) {
			read++
			// Region is required except for region-less locales (NZ: "Private Bag 12, Auckland 1010").
			const regionOptional = ["NZ", "NZL", "NEW ZEALAND"].includes(String(tuple.country || "").toUpperCase())

			if (!tuple.locality || !tuple.postcode || !tuple.country || (!tuple.region && !regionOptional)) {
				skipped++

				continue
			}

			for (let v = 0; v < opts.variants; v++) {
				const synth = synthesizePoBoxRow(tuple as PoBoxBaseTuple, { random, pmbRatio })

				if (!synth) continue

				const ok = alignAndWrite(
					write,
					{
						raw: synth.raw,
						components: synth.components,
						country: tuple.country,
						locale: synth.locale,
						source,
						source_id: recipeSourceID(source, {
							locality: tuple.locality,
							region: tuple.region,
							postcode: tuple.postcode,
							country: tuple.country,
							v: String(v),
						}),
						corpus_version: "0.4.0",
						license: LICENSE,
					},
					synth.template,
					PO_BOX_PROVENANCE
				)

				if (ok) {
					emitted++
				} else {
					skipped++
				}
			}

			// US military/diplomatic rows, self-contained, one per input line at --military-ratio.
			// The default of 0 keeps the output byte-stable, because random() is not called when the ratio is 0.
			// US-only.
			if (militaryRatio > 0 && random() < militaryRatio) {
				const mil = synthesizeMilitaryPoBoxRow({ random })

				const ok = alignAndWrite(
					write,
					{
						raw: mil.raw,
						components: mil.components,
						country: "US",
						locale: mil.locale,
						source,
						source_id: recipeSourceID(source, {
							po_box: mil.components.po_box,
							locality: mil.components.locality,
							region: mil.components.region,
							postcode: mil.components.postcode,
							v: `mil${emitted}`,
						}),
						corpus_version: "0.4.0",
						license: LICENSE,
					},
					mil.template,
					PO_BOX_PROVENANCE
				)

				if (ok) {
					emitted++
				} else {
					skipped++
				}
			}
		}

		return { read, emitted, skipped }
	},
}
