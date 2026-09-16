/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `anchor-absorption` recipe (#220/#723, Probe A1) — self-generates `--count` rows from
 *   {@link synthesizeAnchorAbsorptionRow}'s six-template mix (CASE-H / CASE-P-us-rural / CASE-P-de /
 *   anchor-fp / locale-ambig / standard), aligns each to BIO, and emits a labeled JSONL. The
 *   LEADING 5-digit on CASE-H/anchor-fp/locale-ambig is sampled from the REAL US ZIPs in the
 *   postcode-anchor lookup, so the shaped-painted anchor fires on it exactly as inference does —
 *   teaching the model to OVERRIDE a present anchor from context. Ported from the root build
 *   script it replaced.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { makeLcg } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import { recipeSourceID, type CorpusRecipe } from "#recipes/scaffold"
import { synthesizeAnchorAbsorptionRow } from "#synthesizers/anchor-absorption"
import { alignRow } from "#utils"

/**
 * The leading-5-digit source: the real US ZIPs in the postcode anchor's pilot lookup. Resolved through the data-root
 * helper (the lab default is `$MAILWOMAN_DATA_ROOT`), never re-hardcoded.
 */
const ANCHOR_LOOKUP = dataRootPath("anchor", "pilot-anchor-lookup.json")

/**
 * The real US ZIPs in the anchor lookup (entries whose value is a `[{ US: … }]` candidate list).
 */
async function loadRealUsZips(path: PathBuilderLike): Promise<string[]> {
	const d = await readLocalJSONFile<Record<string, unknown>>(path)
	const zips: string[] = []

	for (const [pc, v] of Object.entries(d)) {
		if (Array.isArray(v) && v[0] && typeof v[0] === "object" && "US" in (v[0] as object) && /^\d{5}$/.test(pc)) {
			zips.push(pc)
		}
	}

	return zips
}

/**
 * Recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise, and
 * `description` below for the surface form it generates.
 */
export const anchorAbsorptionRecipe: CorpusRecipe = {
	name: "anchor-absorption",
	description: "Anchor-absorption counter-augmentation (#220/#723): six-template mix → synthesizeAnchorAbsorptionRow",
	mode: "generate",
	async run(opts, write) {
		// Emit PRNG: the root build script this recipe replaced seeded an LCG (lcg(opts.seed)).
		const random = makeLcg(opts.seed)
		const source = opts.sourceName ?? "synth-anchor-absorption"
		const count = opts.count ?? 50_000
		const realZips = await loadRealUsZips(ANCHOR_LOOKUP)

		console.error(`Loaded ${realZips.length} real US ZIPs from the anchor lookup (the leading-5-digit source).`)

		let written = 0
		let quarantined = 0
		const byTemplate: Record<string, number> = {}

		for (let i = 0; i < count; i++) {
			const synth = synthesizeAnchorAbsorptionRow({ random, realZips })
			const country = synth.locale.split("-")[1]

			// "en-US" -> "US", "de-DE" -> "DE"
			const canonical = {
				raw: synth.raw,
				components: synth.components,
				country,
				locale: synth.locale,
				source,
				source_id: recipeSourceID(source, { v: String(i) }),
			}

			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled") {
				quarantined++

				continue
			}

			write(stringifyJSON({ ...aligned.row, synth_method: "anchor-absorption", synth_template: synth.template }))

			written++
			byTemplate[synth.template] = (byTemplate[synth.template] ?? 0) + 1
		}

		console.error(`\nwrote ${written} rows (${quarantined} quarantined)`)
		console.error("  by template:", stringifyJSON(byTemplate))

		return { emitted: written, skipped: quarantined }
	},
}
