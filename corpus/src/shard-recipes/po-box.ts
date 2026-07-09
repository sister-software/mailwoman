/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `po-box` shard recipe — synthetic PO box rows: tuples → {@link synthesizePoBoxRow} → aligned
 *   LabeledRow, plus optional self-contained US military/diplomatic rows (#517) at
 *   `--military-ratio`. Region is required EXCEPT region-less locales (NZ). Ported from
 *   scripts/build-po-box-shard.mjs.
 */

import { synthesizeMilitaryPoBoxRow, synthesizePoBoxRow, type PoBoxBaseTuple } from "../synthesize-po-box.ts"
import { alignAndWrite, makeLcg, readTuples, shardSourceID, type ShardRecipe } from "./scaffold.ts"

const LICENSE = "Synthetic — derived from CC-BY / public-domain input tuples"

export const poBoxRecipe: ShardRecipe = {
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
		let read = 0
		let emitted = 0
		let skipped = 0

		for await (const tuple of readTuples(opts.input)) {
			read++
			// Region required EXCEPT region-less locales (NZ: "Private Bag 12, Auckland 1010", #517).
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
						source: "synth-po-box",
						source_id: shardSourceID("synth-po-box", {
							locality: tuple.locality,
							region: tuple.region,
							postcode: tuple.postcode,
							country: tuple.country,
							v: String(v),
						}),
						corpus_version: "0.4.0",
						license: LICENSE,
					},
					synth.template
				)

				if (ok) {
					emitted++
				} else {
					skipped++
				}
			}

			// US military/diplomatic rows (#517): self-contained, one per input line at --military-ratio.
			// Default 0 → byte-stable (random() not called when off). US-only.
			if (militaryRatio > 0 && random() < militaryRatio) {
				const mil = synthesizeMilitaryPoBoxRow({ random })
				const ok = alignAndWrite(
					write,
					{
						raw: mil.raw,
						components: mil.components,
						country: "US",
						locale: mil.locale,
						source: "synth-po-box",
						source_id: shardSourceID("synth-po-box", {
							po_box: mil.components.po_box,
							locality: mil.components.locality,
							region: mil.components.region,
							postcode: mil.components.postcode,
							v: `mil${emitted}`,
						}),
						corpus_version: "0.4.0",
						license: LICENSE,
					},
					mil.template
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
