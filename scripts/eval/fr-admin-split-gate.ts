/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fr-admin-split-gate.ts — the LIVE gate for the v1.8.0 international admin-split candidate (night
 *   2026-06-19). Runs the production ship-config parse (createScorer: anchor + gazetteer +
 *   conventions=auto) → resolve (createWOFResolver, defaultCountry FR) → coordinate on the HELD-OUT
 *   FR golden set (disjoint communes, with truth coords), and reports the metrics that decide the
 *   promote: assembled centroid error, resolve-rate, région-emit-rate, and the #727 diacritic
 *   break.
 *
 *   Grade the ASSEMBLED anchor-ON coordinate, never label-F1. Run for v1.5.0 (baseline) and the
 *   v1.8.0 candidate; promote iff the candidate's mean centroid error ≤ 0.95× v1.5.0 AND the US
 *   guardrail (separate oa-resolver-eval run) holds.
 *
 *   Run: node --experimental-strip-types scripts/eval/fr-admin-split-gate.ts\
 *   --model <int8.onnx> --tokenizer <tok> --model-card neural-weights-en-us/model-card.json\
 *   --anchor-lookup $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json\
 *   --golden /tmp/reg/fr-admin-split-golden.jsonl --label v1.5.0 --out /tmp/reg/gate-v150.json
 */

import { readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { type AddressNode, type AddressTree, decodeAsJSON } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { hardCountryFor, isBareLocalityTree } from "@mailwoman/core/pipeline"
import { dataRootPath } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../lib/cli-args.ts"

/**
 * CONVENTION EPOCH 2026-07-04 (#945, operator-promoted): the DEFAULT scoring coordinate is the one production's
 * result-assembly ladder picks — LOCALITY over postcode (geocode-core `adminPriority`). The harness historically scored
 * the postcode point (rank 6 > 5), which measured a non-production preference and hid a 1.5 km-class FR gap for weeks.
 * All dumps BEFORE this epoch are postcode-convention: NEVER compare across conventions (the tokenizer-F1 rule,
 * coordinate edition). `--prefer-postcode-coord` reproduces the old convention for continuity runs only.
 */
const PLACETYPE_RANK: Record<string, number> = {
	locality: 6,
	postalcode: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	country: 0,
}

/** The pre-epoch (postcode-point) convention — continuity runs against pre-2026-07-04 dumps only. */
const POSTCODE_CONVENTION_RANK: Record<string, number> = { ...PLACETYPE_RANK, postalcode: 6, locality: 5 }
interface Resolved {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
}
function collectResolved(tree: AddressTree): Resolved[] {
	const out: Resolved[] = []
	const visit = (n: AddressNode): void => {
		const meta = n.metadata as Record<string, unknown> | undefined

		if (n.placeID?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceID ?? "").split(":")[0] ?? ""
			out.push({
				id: Number(n.placeID.slice(4)),
				name: String(meta?.["resolver_name"] ?? n.value ?? ""),
				placetype,
				lat: n.lat,
				lon: n.lon,
			})
		}

		for (const c of n.children) visit(c)
	}

	for (const r of tree.roots) visit(r)

	return out
}
function mostSpecific(rs: Resolved[], rank: Record<string, number> = PLACETYPE_RANK): Resolved | null {
	let best: Resolved | null = null

	for (const r of rs) if (!best || (rank[r.placetype] ?? -1) > (rank[best.placetype] ?? -1)) best = r

	return best
}
const pct = (xs: number[], p: number): number => {
	if (xs.length === 0) return NaN
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const norm = (s: string | undefined): string =>
	(s ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.trim()

const FR_CENTROID = { lat: 46.6, lon: 2.5 }

async function main() {
	const goldenPath = arg("golden", "/tmp/reg/fr-admin-split-golden.jsonl")
	const label = arg("label", "model")
	// Comma-separated multi-shard support (night-31): postcodeConsistency needs a resolvable postcode
	// node, which needs a postalcode shard attached alongside the admin DB.
	const wofDBArg = arg("wof-db", dataRootPath("wof", "admin-global-priority.db"))
	const wofDB = wofDBArg.includes(",") ? wofDBArg.split(",") : wofDBArg
	const rows = readFileSync(goldenPath, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l))

	const [{ WOFSqlitePlaceLookup }, { createScorer }, { createWOFResolver }, { loadDefaultPlaceCountry }] =
		await Promise.all([
			import("@mailwoman/resolver-wof-sqlite"),
			import("@mailwoman/neural/scorer"),
			import("@mailwoman/resolver"),
			import("mailwoman"),
		])

	const anchorPath = arg("anchor-lookup", dataRootPath("anchor", "pilot-anchor-lookup.json"))
	const neural = await createScorer({
		modelPath: arg("model"),
		tokenizerPath: arg("tokenizer"),
		modelCardPath: arg("model-card"),
		...(anchorPath ? { anchorLookupPath: anchorPath } : {}),
		strict: true,
		tier: "server",
	})
	// #936 option 3 gate legs: `--official-name-exact` flips the official-name sub-tier promotion on
	// Boolean pin flags via node:util parseArgs (strict off — the string args ride the `arg()` helper).
	// #895/#718 discipline: the tri-state pins keep gate legs reproducible against pre-flip baselines —
	// the positive flag pins ON, the `--no-*`/inverse flag pins OFF (the historical config), no flag =
	// the current library default. Pin explicitly in pre-registered legs.
	const { values: pins } = parseArgs({
		options: {
			// #936: official-language names join the name-exact sub-tier (library default ON since 2026-07-03).
			"official-name-exact": { type: "boolean" },
			"admin-coherence": { type: "boolean" },
			"no-admin-coherence": { type: "boolean" },
			"normalize-case": { type: "boolean" },
			"raw-case": { type: "boolean" },
			// #375 night-31: opt-in postcodeConsistency (the #370 lever A namesake binder).
			"postcode-consistency": { type: "boolean" },
			// #942: postal-compound recovery (library default ON since the 2026-07-03 promote).
			"postal-compound-recovery": { type: "boolean" },
			"no-postal-compound-recovery": { type: "boolean" },
			// #965: apply the SAME production scoping geocode-core does — the coarse-placer anchorPosterior
			// re-rank + the #743 hard-country filter — on top of the soft `--default-country`. Without it the
			// harness overstates the wrong-country p90 tail for namesake locales (fi 270 km vs production ~3).
			"hard-country": { type: "boolean" },
			// Convention epoch 2026-07-04: locality-first is the DEFAULT (production's ladder). This flag
			// reproduces the pre-epoch postcode-point convention for continuity against old dumps only.
			"prefer-postcode-coord": { type: "boolean" },
			// Pre-epoch spelling — accepted so in-flight scripts don't silently change convention; it IS
			// the default now, so it's a no-op.
			"prefer-locality-coord": { type: "boolean" },
		},
		strict: false,
	})
	const tri = (on: keyof typeof pins, off: keyof typeof pins): boolean | undefined =>
		pins[on] === true ? true : pins[off] === true ? false : undefined

	const officialNameExact = pins["official-name-exact"] === true
	const resolver = createWOFResolver(
		new WOFSqlitePlaceLookup({ databasePath: wofDB }, officialNameExact ? { officialNameExact } : undefined) as never
	)
	const adminCoherencePin = tri("admin-coherence", "no-admin-coherence")
	const normalizeCasePin = tri("normalize-case", "raw-case")
	const postcodeConsistencyPin = pins["postcode-consistency"] === true ? true : undefined
	const postalCompoundPin = tri("postal-compound-recovery", "no-postal-compound-recovery")
	// `--default-country none` = truly UNSCOPED resolution (no country prior at all) — the #936
	// namesake legs need it; an empty string would still be a (falsy, ambiguous) country value.
	const defaultCountryArg = arg("default-country", "FR")
	const resolveOpts: {
		defaultCountry?: string
		adminCoherence?: boolean
		postcodeConsistency?: boolean
		postalCompoundRecovery?: boolean
		anchorPosterior?: Record<string, number>
		anchorWeight?: number
		hardCountry?: string
	} = {
		...(defaultCountryArg === "none" ? {} : { defaultCountry: defaultCountryArg }),
		...(adminCoherencePin !== undefined ? { adminCoherence: adminCoherencePin } : {}),
		...(postcodeConsistencyPin !== undefined ? { postcodeConsistency: postcodeConsistencyPin } : {}),
		...(postalCompoundPin !== undefined ? { postalCompoundRecovery: postalCompoundPin } : {}),
	}

	// #965: when `--hard-country` is set, load the bundled coarse placer and apply the SAME scoping
	// geocode-core does per row (anchorPosterior + anchorWeight + the #743 hard-country filter). This
	// makes the harness's absolute p90s production-equivalent for namesake locales. `hardCountryFor` is
	// a no-op when defaultCountry is set (the caller's country wins), so the hard filter only bites the
	// unscoped `--default-country none` legs — exactly matching geocode-core's precedence.
	const hardCountryPin = pins["hard-country"] === true
	const placeCountry = hardCountryPin ? await loadDefaultPlaceCountry() : null
	const COARSE_PLACER_ANCHOR_WEIGHT = 1.0 // keep in sync with geocode-core.ts

	const errs: number[] = []
	const resolvedErrs: number[] = [] // coordinate error over RESOLVED rows only (unconfounded by the unresolved penalty)
	// Per-row records for a paired A/B bootstrap (--dump-rows): index-aligned across model runs on the SAME
	// golden, so coord-ab-bootstrap.ts can resample rows and compute a paired p50-diff / resolve-rate CI.
	const rowRecords: Array<{ i: number; resolved: boolean; err_km: number | null }> = []
	let rowIdx = -1
	let resolved = 0,
		regionEmitted = 0,
		regionCorrect = 0,
		diacriticBroken = 0,
		hasGoldRegion = 0

	for (const row of rows) {
		rowIdx++
		const tree = await neural.parse(row.raw, {
			postcodeRepair: true,
			enforceWordConsistency: $public.MAILWOMAN_WORD_CONSISTENCY === "1",
			...(normalizeCasePin !== undefined ? { normalizeCase: normalizeCasePin } : {}),
		})
		const flat = decodeAsJSON(tree) as Record<string, string>
		const goldRegion = row.components?.region as string | undefined
		const predRegion = flat.region

		if (goldRegion) {
			hasGoldRegion++

			if (predRegion) {
				regionEmitted++

				if (norm(predRegion) === norm(goldRegion)) regionCorrect++
				// #727: a broken diacritic subword — pred is a strict, shorter suffix of gold ("ère" of "Lozère").
				else if (
					goldRegion.length > predRegion.length &&
					norm(goldRegion).endsWith(norm(predRegion)) &&
					predRegion.length <= 4
				)
					diacriticBroken++
			}
		}
		// #965: mirror geocode-core's per-row scoping when `--hard-country` — coarse placer → anchorPosterior
		// re-rank (+ hard-country filter on the unscoped legs). The placer abstains on a bare-locality tree
		// (same isBareLocalityTree guard geocode-core uses), and hardCountryFor no-ops when defaultCountry set.
		let rowResolveOpts = resolveOpts
		if (placeCountry && !isBareLocalityTree(tree)) {
			const placed = placeCountry(row.raw)
			if (placed.country && placed.country !== "OTHER") {
				const hardCountry = hardCountryFor(placed.country, placed.confidence, resolveOpts, true, undefined)
				rowResolveOpts = {
					...resolveOpts,
					anchorPosterior: placed.posterior ?? { [placed.country]: placed.confidence },
					anchorWeight: COARSE_PLACER_ANCHOR_WEIGHT,
					...(hardCountry ? { hardCountry } : {}),
				}
			}
		}
		const best = mostSpecific(
			collectResolved(await resolver.resolveTree(tree, rowResolveOpts)),
			pins["prefer-postcode-coord"] === true ? POSTCODE_CONVENTION_RANK : PLACETYPE_RANK
		)

		if (best) {
			resolved++
			const e = haversineKm(best.lat, best.lon, row.lat, row.lon)
			errs.push(e)
			resolvedErrs.push(e)
			rowRecords.push({ i: rowIdx, resolved: true, err_km: e })
		} else {
			errs.push(haversineKm(FR_CENTROID.lat, FR_CENTROID.lon, row.lat, row.lon))
			rowRecords.push({ i: rowIdx, resolved: false, err_km: null })
		}
	}

	const n = rows.length
	const summary = {
		label,
		n,
		coord_mean_km: +mean(errs).toFixed(2),
		coord_p50_km: +pct(errs, 50).toFixed(2),
		coord_p90_km: +pct(errs, 90).toFixed(2),
		// RESOLVED-ONLY coordinate: the quality WHERE the address resolves, separated from the
		// unresolved penalty (which pins to FR_CENTROID and is meaningless for non-FR locales).
		coord_p50_resolved_km: resolvedErrs.length ? +pct(resolvedErrs, 50).toFixed(2) : null,
		coord_p90_resolved_km: resolvedErrs.length ? +pct(resolvedErrs, 90).toFixed(2) : null,
		resolve_rate: +(resolved / n).toFixed(4),
		region_emit_rate: hasGoldRegion ? +(regionEmitted / hasGoldRegion).toFixed(4) : null,
		region_correct_rate: hasGoldRegion ? +(regionCorrect / hasGoldRegion).toFixed(4) : null,
		diacritic_broken: diacriticBroken,
		gold_region_rows: hasGoldRegion,
	}
	console.log(JSON.stringify(summary, null, 2))
	const outPath = arg("out")

	if (outPath) {
		writeFileSync(outPath, JSON.stringify(summary, null, 2))
		console.error(`wrote ${outPath}`)
	}

	// Per-row dump for the paired A/B bootstrap. One JSON line per golden row, index-aligned to the input.
	const dumpPath = arg("dump-rows")

	if (dumpPath) {
		writeFileSync(dumpPath, rowRecords.map((r) => JSON.stringify(r)).join("\n") + "\n")
		console.error(`wrote per-row dump: ${dumpPath} (${rowRecords.length} rows)`)
	}
}

await main()
