/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `no-street-led` — the Norwegian street-led shard, third orthography of the #901
 *   leading-name-boundary family. The post-#920 NO row-read measured the residual as
 *   ORDER-SENSITIVE decode: street-led forms ("Tangavegen 40, 5620 Tørvikbygd") carry a 30%
 *   residual vs pc-first's 7% — the diacritic street head (…vegen/…veien with ø/å/æ) is the same
 *   leading-name-before-comma boundary the FR bare-street and SI village forms exercise, in a
 *   third orthography. All three real orders cycle per tuple (balanced polarity — the v1.9.9
 *   lesson: a one-order gradient loses at convergence):
 *
 *   1. canonical  "«st» «n», «pc» «city»"   (the 30% residual class — the lesson)
 *   2. city-first "«city», «pc», «st» «n»"
 *   3. pc-first   "«pc» «city», «st» «n»"   (the 7% floor — the anchor the others converge to)
 */

import { readFileSync } from "node:fs"

import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.ts"

/**
 * The surface key. MUST match the NO digit board's `norm_surface` (scratchpad/build-no-board.py): NFC, lowercase,
 * collapse whitespace — and critically, KEEP diacritics. fr-fragment's `norm` strips them (NFD + combining-mark
 * removal), which is right for French but would collapse `Tømmerlien` → `tommerlien` here, so the shard's exclusion
 * check would never match the board's reserved `tømmerlien` and the split would leak silently. Diacritic street heads
 * (…vegen/…veien with ø/å/æ) are the whole point of this shard's boundary; folding them away is not an option.
 */
const norm = (value: string): string => value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

export const noStreetLedRecipe: ShardRecipe = {
	name: "no-street-led",
	description: "NO street-led boundary form (#901 family): '«st» «n», «pc» «city»' — diacritic street heads",
	mode: "tuples",
	options: [
		{
			flag: "--exclude-surfaces <path>",
			description:
				"REQUIRED. The NO digit board's reserved surface list " +
				"(mailwoman/eval-harness/fixtures/no-digits.surfaces.txt); every listed street is skipped.",
		},
	],
	async run(opts, write) {
		makeMulberry32(opts.seed)

		// THE SPLIT (ported from fr-fragment, #727 T2). Without it this shard trains on all 10,697
		// NO surfaces, 1,952 of which the digit board reserves — so a Norway retrain would grade
		// memorization of `Hallingrudveien` while claiming to measure the boundary form. There is no
		// safe default: source-disjoint by street SURFACE is the discipline, so the flag throws.
		const excludePath = opts.excludeSurfaces

		if (!excludePath) {
			throw new Error(
				"no-street-led: --exclude-surfaces is REQUIRED. Pass the NO digit board's reserved list " +
					"(mailwoman/eval-harness/fixtures/no-digits.surfaces.txt) or this shard trains on its own eval set. " +
					"Source-disjoint by street SURFACE is the split discipline; there is no safe default."
			)
		}

		const excluded = new Set(
			readFileSync(excludePath, "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"))
		)

		if (!excluded.size) throw new Error(`no-street-led: --exclude-surfaces "${excludePath}" listed no surfaces`)

		let read = 0
		let emitted = 0
		let skipped = 0
		let contaminated = 0

		for await (const t of readTuples(opts.input!)) {
			read++
			const street = String(t.street ?? "").trim()
			const city = String(t.locality ?? "").trim()
			const number = String(t.number ?? "").trim()
			const postcode = String(t.postcode ?? "").trim()

			if (!street || !city || !number || !postcode) {
				skipped++
				continue
			}

			// A surface on the digit board never enters training.
			if (excluded.has(norm(street))) {
				contaminated++
				continue
			}
			const order = read % 3
			let raw: string
			const components: Record<string, string> = {
				street,
				house_number: number,
				postcode,
				locality: city,
			}

			if (order === 0) {
				raw = `${street} ${number}, ${postcode} ${city}`
			} else if (order === 1) {
				raw = `${city}, ${postcode}, ${street} ${number}`
			} else {
				raw = `${postcode} ${city}, ${street} ${number}`
			}
			const source_id = shardSourceID("synth-no-street-led", { ...components, o: String(order), v: String(read) })
			const canonical = {
				raw,
				components,
				country: "NO",
				locale: "nb-NO",
				source: "synth-no-street-led",
				source_id,
				corpus_version: "0.10.0",
				license:
					"Synthetic — no-street-led; (street, number, postcode, city) from OpenAddresses NO (per-source attribution in the model card)",
			}

			if (alignAndWrite(write, canonical, "no-street-led")) {
				emitted++
			} else {
				skipped++
			}
		}

		return { read, emitted, skipped, contaminated }
	},
}
