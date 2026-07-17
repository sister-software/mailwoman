/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `no-fragment` — the Norwegian house-number-licence lever (Track B, 2026-07-16). The mirror of
 *   `fr-fragment`, which earned +50pp on the same defect shape in French.
 *
 *   WHY THIS EXISTS AND `no-street-led` DOES NOT SUFFICE. Board 3 (the NO digit board) measured that
 *   `synth-no-street-led`'s three forms — all carrying postcode+city — are ALREADY at 0.940-0.968 on
 *   a model with zero Norwegian rows. The headroom is in the forms that shard never emits:
 *
 *     bare-street-hn   "Hallingrudveien 32"     0.693   — no postcode competing, still fails 31%
 *     slash-hn         "Øvrabø 124/1"           0.650   — cadastral gnr/bnr, ONE component
 *
 *   THE MECHANISM the board exposed: `Hallingrudveien 32` -> locality + postcode, while
 *   `Hallingrudveien 32, 3370 Vikersund` parses perfectly. The street loses its street reading and
 *   the digit loses its anchor TOGETHER. That is Track A's bare-street LICENCE in Norwegian — the
 *   model will not read a street without its postcode/locality partner — not a digit-ownership prior.
 *   fr-fragment fixed exactly this in French by teaching the street WITHOUT its partners.
 *
 *   THE COUNTER-DISTRIBUTION IS THE POINT (fr-fragment's lesson, and board 2's bare-locality guard).
 *   Teaching bare `{street} {number}` alone lets the model satisfy every row by flipping its default
 *   from "bare toponym -> locality" to "bare toponym -> street", trading one broken prior for
 *   another. Two counter-classes hold the line:
 *     - bare LOCALITIES (no street) so "bare -> street" is not free.
 *     - bare POSTCODES so the model does not learn to stop emitting postcode to win the digit — the
 *       board 3 bare-pc negative class (1.000) must HOLD.
 *
 *   SLASH HAZARD, pinned deliberately: NO `124/1` is ONE house_number (cadastral gnr/bnr). AU
 *   `12/345` is TWO (unit + house_number). This shard teaches the Norwegian reading; a future AU
 *   intra-word-split shard (B5) must not generalize over it. The two are locale-gated by design.
 *
 *   SPLIT: `--exclude-surfaces` REQUIRED (throws otherwise) — the digit board's reserved surface
 *   list. Diacritic-KEEPING normalizer, matching the board (see the norm docstring).
 */

import { readFileSync } from "node:fs"

import { alignAndWrite, makeMulberry32, readTuples, type ShardRecipe, shardSourceID } from "./scaffold.ts"

/**
 * The surface key — MUST match the NO digit board's `norm_surface` and `no-street-led`'s `norm`: NFC, lowercase,
 * collapse whitespace, KEEP diacritics. Stripping them (fr-fragment's norm) would fold `Tømmerlien` -> `tommerlien`,
 * miss the board's reserved `tømmerlien`, and leak the surface.
 */
const norm = (value: string): string => value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()

/** Title-case a Kartverket ALL-CAPS locality (HELLVIK -> Hellvik); #690, all-caps is OOD. */
const titleNO = (value: string): string =>
	value
		.split(/\s+/)
		.map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
		.join(" ")

export const noFragmentRecipe: ShardRecipe = {
	name: "no-fragment",
	description:
		"NO street fragments — the house-number-licence lever (Track B): '«st» «n»' / bare «st» with NO postcode partner, + bare-locality & bare-postcode counters",
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

		if (!excluded.size) throw new Error(`no-fragment: --exclude-surfaces "${excludePath}" listed no surfaces`)

		const bareStreetProb = opts.bareProb ?? 0.3
		const counterProb = opts.counterProb ?? 0.3
		const longNumberBoost = Math.max(1, Math.floor(opts.longNumberBoost ?? 1))
		const longNumberMinDigits = opts.longNumberMinDigits ?? 3

		// Harvested from the tuples — every NO row carries its locality and postcode, so the two
		// counter-classes need no second source.
		const localities = new Set<string>()
		const postcodes = new Set<string>()

		let read = 0
		let emitted = 0
		let skipped = 0
		let contaminated = 0
		let emitSeq = 0

		const emit = (raw: string, components: Record<string, string>, klass: string): void => {
			// emitSeq keeps every emit distinct — knob 3 emits N copies of one long-number row, and
			// (components, read) alone would collide their source_id and let downstream dedup drop the boost.
			const source_id = shardSourceID("synth-no-fragment", { ...components, k: klass, v: `${read}:${emitSeq++}` })
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

			if (alignAndWrite(write, canonical, "no-fragment")) {
				emitted++
			} else {
				skipped++
			}
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

			// THE SPLIT. A surface on the digit board never enters training.
			if (excluded.has(norm(street))) {
				contaminated++
				continue
			}

			// COUNTER-DISTRIBUTION — drawn from the harvested pools, not this row's street. Half bare
			// localities (so "bare -> street" is not free), half bare postcodes (so the model does not
			// stop emitting postcode to win the digit — board 3's bare-pc must hold).
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

			// THE SIGNAL. A street with NO postcode/locality partner. Either bare, or street+number —
			// both are the forms board 3 measured as the headroom (bare-street-hn 0.693, slash-hn 0.650).
			if (!number || random() < bareStreetProb) {
				emit(street, { street }, "bare-street")
			} else {
				const klass = number.includes("/") ? "slash-hn" : "street-hn"
				// knob 3: the failing class is street + LONG number (Leppdalsvegen 1285 -> postcode). The
				// digit count, not the slash, is what tips the length prior toward postcode. Oversample
				// those rows to fight the prior with volume and teach the street/number boundary directly.
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
