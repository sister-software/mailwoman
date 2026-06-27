/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `anchor-absorption` shard recipe (#220/#723, Probe A1) — self-generates `--count` rows from
 *   {@link synthesizeAnchorAbsorptionRow}'s 6-slice mix (CASE-H / CASE-P-us-rural / CASE-P-de /
 *   anchor-fp / locale-ambig / standard), aligns each to BIO, and emits a labeled JSONL. The
 *   LEADING 5-digit on CASE-H/anchor-fp/locale-ambig is sampled from the REAL US ZIPs in the
 *   postcode-anchor lookup, so the shaped-painted anchor fires on it exactly as inference does —
 *   teaching the model to OVERRIDE a present anchor from context. Ported from
 *   scripts/build-anchor-absorption-shard.mjs.
 */

import { readFileSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"

import { stableSourceId } from "../adapter.js"
import { alignRow } from "../align.js"
import { synthesizeAnchorAbsorptionRow } from "../synthesize-anchor-absorption.js"
import { makeLcg, type ShardRecipe } from "./scaffold.js"

// The leading-5-digit source: the real US ZIPs in the postcode anchor's pilot lookup. Resolved through
// the data-root helper (the lab default is `$MAILWOMAN_DATA_ROOT`), never re-hardcoded.
const ANCHOR_LOOKUP = dataRootPath("anchor", "pilot-anchor-lookup.json")

/** The real US ZIPs in the anchor lookup (entries whose value is a `[{ US: … }]` candidate list). */
function loadRealUsZips(path: string): string[] {
	const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
	const zips: string[] = []
	for (const [pc, v] of Object.entries(d)) {
		if (Array.isArray(v) && v[0] && typeof v[0] === "object" && "US" in (v[0] as object) && /^\d{5}$/.test(pc)) {
			zips.push(pc)
		}
	}
	return zips
}

export const anchorAbsorptionRecipe: ShardRecipe = {
	name: "anchor-absorption",
	description: "Anchor-absorption counter-augmentation (#220/#723): 6-slice mix → synthesizeAnchorAbsorptionRow",
	mode: "generate",
	async run(opts, write) {
		// Emit PRNG: the legacy build-anchor-absorption-shard.mjs seeded an LCG (lcg(opts.seed)).
		const random = makeLcg(opts.seed)
		const source = opts.sourceName ?? "synth-anchor-absorption"
		const count = opts.count ?? 50000
		const realZips = loadRealUsZips(ANCHOR_LOOKUP)
		console.error(`Loaded ${realZips.length} real US ZIPs from the anchor lookup (the leading-5-digit source).`)

		let written = 0
		let quarantined = 0
		const byTemplate: Record<string, number> = {}
		for (let i = 0; i < count; i++) {
			const synth = synthesizeAnchorAbsorptionRow({ random, realZips })
			const country = synth.locale.split("-")[1] // "en-US" -> "US", "de-DE" -> "DE"
			const canonical = {
				raw: synth.raw,
				components: synth.components,
				country,
				locale: synth.locale,
				source,
				source_id: stableSourceId(source, `${i}` as unknown as Parameters<typeof stableSourceId>[1]),
			}
			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])
			if (aligned.kind !== "labeled") {
				quarantined++
				continue
			}
			write(
				JSON.stringify({ ...aligned.row, synth_method: "anchor-absorption", synth_template: synth.template }) + "\n"
			)
			written++
			byTemplate[synth.template] = (byTemplate[synth.template] ?? 0) + 1
		}
		console.error(`\nwrote ${written} rows (${quarantined} quarantined)`)
		console.error("  by slice:", JSON.stringify(byTemplate))
		return { emitted: written, skipped: quarantined }
	},
}
