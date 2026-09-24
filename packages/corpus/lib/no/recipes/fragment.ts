/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate Norwegian street/number fragments and bare locality/postcode counterexamples.
 *   Require reserved digit-board surfaces to prevent train/evaluation overlap.
 */

import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { TextSpliterator } from "spliterator"

import {
	alignAndWrite,
	foldNOSurface,
	readTuples,
	requireRegister,
	type CorpusRecipe,
	recipeSourceID,
} from "#recipes/scaffold"
import { SurfaceOrigin } from "#types"

/**
 * Convert a Norwegian locality to title case.
 */
const titleNO = (value: string): string =>
	value
		.split(/\s+/)
		.map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
		.join(" ")

/**
 * Norwegian fragment recipe.
 */
export const noFragmentRecipe: CorpusRecipe = {
	name: "no-fragment",
	description:
		"NO street fragments — the house-number-licence change (Track B): '«st» «n»' / bare «st» with NO postcode partner, + bare-locality & bare-postcode counters",
	mode: "tuples",
	options: [
		{
			flag: "--exclude-surfaces <path>",
			description:
				"REQUIRED. The NO digit board's reserved surface list (mailwoman/eval-harness/fixtures/no-digits.surfaces.txt).",
		},
		{
			flag: "--bare-street-prob <n>",
			description: "Share of street rows emitted as a BARE street, no number (default 0.30 — the pure licence signal)",
		},
		{
			flag: "--counter-prob <n>",
			description: "Share of ALL rows that are counter-distribution (bare locality OR bare postcode) (default 0.30)",
		},
		{
			flag: "--long-number-boost <n>",
			description:
				"knob 3: emit N copies of each street+number row whose number has >= --long-number-min-digits digits — oversample the failing long-number class the model calls a postcode (default 1 = no boost)",
		},
		{
			flag: "--long-number-min-digits <n>",
			description: "knob 3: minimum digit count for a number to be 'long' and boosted (default 3)",
		},
	],
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const excludePath = opts.excludeSurfaces

		if (!excludePath) {
			throw new Error(
				"no-fragment: --exclude-surfaces is REQUIRED. Pass the NO digit board's reserved list " +
					"(mailwoman/eval-harness/fixtures/no-digits.surfaces.txt) or this recipe trains on its own eval set. " +
					"Source-disjoint by street SURFACE is the split discipline; there is no safe default."
			)
		}

		const excluded = new Set<string>()

		for await (const line of TextSpliterator.fromAsync(excludePath)) {
			const trimmed = line.trim()

			if (trimmed && !trimmed.startsWith("#")) {
				excluded.add(trimmed)
			}
		}

		if (!excluded.size) throw new Error(`no-fragment: --exclude-surfaces "${excludePath}" listed no surfaces`)

		const bareStreetProb = opts.bareProb ?? 0.3
		const counterProb = opts.counterProb ?? 0.3
		const longNumberBoost = Math.max(1, Math.floor(opts.longNumberBoost ?? 1))
		const longNumberMinDigits = opts.longNumberMinDigits ?? 3

		// Collect locality and postcode counterexamples.
		const localities = new Set<string>()
		const postcodes = new Set<string>()

		let read = 0
		let emitted = 0
		let skipped = 0
		let contaminated = 0
		let emitSeq = 0

		const emit = (raw: string, components: Record<string, string>, klass: string): void => {
			// Give boosted copies distinct source IDs.
			const source_id = recipeSourceID("synth-no-fragment", { ...components, k: klass, v: `${read}:${emitSeq++}` })

			const canonical = {
				raw,
				components,
				country: "NO",
				locale: "nb-NO",
				source: "synth-no-fragment",
				source_id,
				corpus_version: "0.11.0",
				license: "Synthetic — no-fragment; (street, number, postcode, city) from OpenAddresses NO / Kartverket",
			}

			if (alignAndWrite(write, canonical, "no-fragment", NO_FRAGMENT_PROVENANCE)) {
				emitted++
			} else {
				skipped++
			}
		}

		const NO_FRAGMENT_PROVENANCE = {
			register: requireRegister(opts, "no-fragment"),
			surface: SurfaceOrigin.Composed,
		}

		for await (const tuple of readTuples(opts.input!)) {
			read++
			const street = String(tuple.street ?? "").trim()
			const locality = titleNO(String(tuple.locality ?? "").trim())
			const number = String(tuple.number ?? "").trim()
			const postcode = String(tuple.postcode ?? "").trim()

			if (locality) {
				localities.add(locality)
			}

			if (postcode) {
				postcodes.add(postcode)
			}

			if (!street) {
				skipped++

				continue
			}

			// Keep evaluation surfaces out of training data.
			if (excluded.has(foldNOSurface(street))) {
				contaminated++

				continue
			}

			// Sample bare locality and postcode counterexamples.
			if (random() < counterProb) {
				if (random() < 0.5 && localities.size) {
					const loc = [...localities][Math.floor(random() * localities.size)]!

					emit(loc, { locality: loc }, "counter-bare-locality")
				} else if (postcodes.size) {
					const pc = [...postcodes][Math.floor(random() * postcodes.size)]!

					emit(pc, { postcode: pc }, "counter-bare-postcode")
				}

				continue
			}

			// Emit a bare street or street with house number.
			if (!number || random() < bareStreetProb) {
				emit(street, { street }, "bare-street")
			} else {
				const klass = number.includes("/") ? "slash-hn" : "street-hn"
				// Oversample long numbers to reduce postcode misclassification and reinforce the street/number boundary.
				const digits = (number.match(/\d/g) ?? []).length
				const copies = digits >= longNumberMinDigits ? longNumberBoost : 1

				for (let c = 0; c < copies; c++) {
					emit(`${street} ${number}`, { street, house_number: number }, klass)
				}
			}
		}

		return { read, emitted, skipped, contaminated }
	},
}
