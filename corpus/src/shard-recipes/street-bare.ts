/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `street-bare` shard recipe — BARE-street rows (the v0.8.0 harness lever, 2026-06-05). The
 *   `functional.test.ts` cluster (bare street names — "10th Ave", "Main St", "1 Main Pl") was
 *   mislabeled `locality` because {@link synthesizeStreetRow} only ever emitted streets WITH a ",
 *   City, ST ZIP" tail. This recipe emits streets BARE (`--bare-prob`, default 0.6) — no tail, only
 *   `street_prefix`/`street`/`street_suffix` (+ optional `house_number` at `--hn-prob`, default
 *   0.85) — over the built-in {@link DEFAULT_US_BASES} pool (round-robin). Generate-mode, US-only,
 *   in-distribution (no German-collapse risk). Ported from scripts/build-street-bare-shard.mjs.
 *
 *   Byte-fidelity: the legacy script seeded its own mulberry32 from `--seed`
 *   (`mulberry32(opts.seed)`); this recipe re-creates the SAME generator
 *   (`makeMulberry32(opts.seed)`) and preserves the synthesis call order exactly, so `--seed N`
 *   reproduces the legacy run byte-for-byte.
 */

import { alignRow } from "../align.js"
import { DEFAULT_US_BASES } from "../synthesize-intersection.js"
import { synthesizeStreetRow, type StreetBaseTuple } from "../synthesize-street.js"
import { makeMulberry32, shardSourceId, type CanonicalShardRow, type ShardRecipe } from "./scaffold.js"

export const streetBareRecipe: ShardRecipe = {
	name: "street-bare",
	description: "Bare-street rows (US): DEFAULT_US_BASES → synthesizeStreetRow (bare) → aligned LabeledRow",
	mode: "generate",
	options: [
		{ flag: "--bare-prob <p>", description: "P(emit the street BARE — no city/region/postcode tail). Default 0.6" },
		{ flag: "--hn-prob <p>", description: "P(emit a house number). Default 0.85" },
	],
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 3000
		const bareProb = opts.bareProb ?? 0.6
		const hnProb = opts.hnProb ?? 0.85
		const source = opts.sourceName ?? "synth-street-bare"

		let emitted = 0
		let skipped = 0
		let guard = 0

		while (emitted < count && guard++ < count * 5) {
			const base = DEFAULT_US_BASES[emitted % DEFAULT_US_BASES.length]!
			const synth = synthesizeStreetRow(base as StreetBaseTuple, {
				random,
				bareProb,
				includeHouseNumberProb: hnProb,
			})

			if (!synth) {
				skipped++
				continue
			}
			const isBare = synth.components.region === undefined

			const canonical: CanonicalShardRow = {
				raw: synth.raw,
				components: synth.components,
				country: base.country,
				locale: synth.locale,
				source,
				source_id: shardSourceId(source, {
					street: synth.components.street,
					street_suffix: synth.components.street_suffix,
					house_number: synth.components.house_number,
					bare: String(isBare),
					n: String(emitted),
				}),
				corpus_version: "0.4.0",
				license: "Synthetic — US street templates, public-domain street/city pools",
			}

			// Strict labeled-only check (matches the legacy builder): alignRow always returns a `row`
			// (labeled OR quarantined), so the scaffold's `alignAndWrite` would write quarantined rows
			// too — call alignRow directly and skip anything not "labeled".
			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++
				continue
			}
			write(JSON.stringify({ ...aligned.row, synth_method: "street-bare", synth_base_id: null }) + "\n")
			emitted++
		}

		return { emitted, skipped }
	},
}
