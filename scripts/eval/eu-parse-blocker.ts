/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Eu-parse-blocker.ts — the multi-locale PARSE-BLOCKER proxy for the 2026-06-19 coordinate-leverage
 *   sprint (docs/articles/plan/2026-06-19-coordinate-leverage-sprint.md, Workstream A / EU side).
 *
 *   For a locale we cannot yet RESOLVE (zero gazetteer rows for ES/IT/AU), we still want to know
 *   whether the bottleneck is the PARSER or the COVERAGE — without doing a WOF ingest first. The
 *   trick: run the parser on public OA samples and measure the ADMIN-SPLIT rate — when the ground
 *   truth has a `region` (the admin token adjacent to the locality), does the parser EMIT a
 *   separate region, or does it fuse/drop it (the exact failure the FR-admin-split shard fixed)?
 *
 *   - High region-emit → the parser already splits locality from admin → the blocker is COVERAGE (WOF
 *       ingest); the parser is ready.
 *   - Low region-emit → the parser fuses/drops the admin → PARSE-BLOCKED → an admin-split shard (the FR
 *       template, #727-adjacent) is the lever.
 *
 *   Routing (sprint doc): parse_blocker_pct > 0.30 → PARSER_SHARD; else → COVERAGE (parser ready).
 *
 *   No resolver / gazetteer needed — parse only. Uses the ship-config scorer (anchor + gazetteer +
 *   conventions auto) and the #690 case-normalize (IT OA is all-caps; the geocoder ingest
 *   normalizes). FR OA carries region=null (OA-France omits the département), so FR's admin-split
 *   is measured by the v1.8.0 BAN gate (région-emit 99.6%), not this sample — FR is reported but
 *   excluded from the metric.
 *
 *   Run (resolver/neural compiled — `yarn compile`): node --experimental-strip-types
 *   scripts/eval/eu-parse-blocker.ts\
 *   --model $MAILWOMAN_DATA_ROOT/models/quantized/model-v180-step-40000-int8.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --anchor-lookup $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json\
 *   --limit 1500 --out /tmp/reg/eu-parse-blocker.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"

import { arg } from "../lib/cli-args.ts"

interface OaRow {
	input: string
	expected: { locality?: string; region?: string; postcode?: string }
}

const norm = (s: string | undefined): string =>
	(s ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.join(" ")
		.trim()

const LOCALES = ["fr", "de", "es", "it", "nl"] as const

async function main(): Promise<void> {
	const limit = parseInt(arg("limit", "1500"), 10)
	const anchorPath = arg("anchor-lookup", dataRootPath("anchor", "pilot-anchor-lookup.json"))
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const neural = await createScorer({
		modelPath: arg("model", dataRootPath("models", "quantized", "model-v180-step-40000-int8.onnx")),
		tokenizerPath: arg("tokenizer", dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")),
		modelCardPath: arg("model-card", "neural-weights-en-us/model-card.json"),
		...(anchorPath ? { anchorLookupPath: anchorPath } : {}),
		strict: true,
		tier: "server",
	})

	const results: Record<string, unknown>[] = []

	for (const loc of LOCALES) {
		const path = `data/eval/external/openaddresses-${loc}-sample.jsonl`

		if (!existsSync(path)) {
			results.push({ locale: loc, error: "sample missing" })
			continue
		}
		const rows = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as OaRow)
			.slice(0, limit)

		let nWithRegion = 0
		let nRegionInInput = 0 // truth region actually present as text in the input (an admin token to split)
		let splitEmitted = 0 // of those, parser emitted a region
		let splitCorrect = 0
		let nWithLoc = 0
		let locEmitted = 0
		let locCorrect = 0
		const fusionExamples: Record<string, unknown>[] = []

		// region IN input but parser dropped it (true admin-split miss)

		for (const row of rows) {
			const tree = await neural.parse(row.input, { normalizeCase: true, postcodeRepair: true })
			const flat = decodeAsJSON(tree) as Record<string, string>
			const truthRegion = row.expected.region
			const truthLoc = row.expected.locality
			const inputNorm = norm(row.input)

			if (truthLoc) {
				nWithLoc++

				if (flat.locality) {
					locEmitted++
				}

				if (flat.locality && norm(flat.locality) === norm(truthLoc)) {
					locCorrect++
				}
			}

			if (truthRegion) {
				nWithRegion++
				// The admin-split lever only applies when the admin token is ACTUALLY in the input text
				// (like FR's "Commune, Département"). For OA "street, postcode locality" the province is
				// metadata implied by the postcode, NOT a token — there is nothing for the parser to split.
				const inInput = norm(truthRegion).length > 0 && inputNorm.includes(norm(truthRegion))

				if (inInput) {
					nRegionInInput++

					if (flat.region) {
						splitEmitted++

						if (norm(flat.region) === norm(truthRegion)) {
							splitCorrect++
						}
					} else if (fusionExamples.length < 12) {
						// admin IS in the input but the parser emitted no region → a TRUE fusion/drop.
						fusionExamples.push({
							input: row.input,
							truth_region: truthRegion,
							pred_locality: flat.locality ?? null,
							pred_region: flat.region ?? null,
						})
					}
				}
			}
		}

		const regionInInputRate = nWithRegion ? nRegionInInput / nWithRegion : null
		const adminSplitRate = nRegionInInput ? splitEmitted / nRegionInInput : null // among in-input-admin rows
		const adminSplitBlocker = adminSplitRate === null ? null : 1 - adminSplitRate
		const locCorrectRate = nWithLoc ? locCorrect / nWithLoc : null
		const p = (x: number | null): string => (x === null ? "n/a" : (100 * x).toFixed(0))

		let route: string

		if (regionInInputRate === null) {
			route = "N/A — no region truth (FR: see v1.8.0 BAN gate, région-emit 99.6%)"
		} else if (regionInInputRate < 0.15) {
			route = `COVERAGE — admin token absent from input (${p(regionInInputRate)}%); no split to learn. Lever = locality resolution + postcode→region. Parse-readiness loc-correct=${p(locCorrectRate)}%`
		} else if (adminSplitBlocker !== null && adminSplitBlocker > 0.3) {
			route = `PARSER_SHARD — admin IS in input but parser drops it (${p(adminSplitBlocker)}% of in-input rows); admin-split shard, FR template`
		} else {
			route = `COVERAGE — parser splits the in-input admin (split=${p(adminSplitRate)}%); WOF ingest is the lever`
		}

		results.push({
			locale: loc,
			n: rows.length,
			n_with_region: nWithRegion,
			region_in_input_rate: regionInInputRate === null ? null : +(100 * regionInInputRate).toFixed(1),
			admin_split_rate: adminSplitRate === null ? null : +(100 * adminSplitRate).toFixed(1),
			admin_split_correct_rate: nRegionInInput ? +((100 * splitCorrect) / nRegionInInput).toFixed(1) : null,
			admin_split_blocker_pct: adminSplitBlocker === null ? null : +(100 * adminSplitBlocker).toFixed(1),
			loc_emit_rate: nWithLoc ? +((100 * locEmitted) / nWithLoc).toFixed(1) : null,
			loc_correct_rate: locCorrectRate === null ? null : +(100 * locCorrectRate).toFixed(1),
			route,
			fusion_examples: fusionExamples,
		})
		const r = results[results.length - 1]!
		console.error(
			`[${loc}] region-in-input=${r.region_in_input_rate}% admin-split=${r.admin_split_rate}% loc-correct=${r.loc_correct_rate}% → ${r.route}`
		)
	}

	console.log(JSON.stringify({ limit, results }, null, 2))
	const out = arg("out")

	if (out) {
		writeFileSync(out, JSON.stringify({ limit, results }, null, 2))
		console.error(`wrote ${out}`)
	}
}

await main()
