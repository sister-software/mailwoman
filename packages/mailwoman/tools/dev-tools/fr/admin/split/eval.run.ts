/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The live eval for the v1.8.0 international admin-split candidate. Runs the production ship-config
 *   parse (createScorer: anchor + gazetteer + conventions=auto) → resolve (createWOFResolver,
 *   defaultCountry FR) → coordinate on the held-OUT FR golden set (disjoint communes, with truth
 *   coords). The report includes assembled centroid error, resolve rate, région emit rate,
 *   plus the diacritic break.
 *
 *   Grade the assembled anchor-on coordinate, never label-F1. Run for v1.5.0 (baseline) and the
 *   v1.8.0 candidate. promote iff the candidate's mean centroid error ≤ 0.95× v1.5.0 and the US
 *   guardrail (separate oa-resolver-eval run) holds.
 *
 *   Run: node packages/mailwoman/tools/dev-tools/fr/admin/split/eval.run.ts\
 *   --model <int8.onnx> --tokenizer <tok> --model-card neural-weights-en-us/model-card.json\
 *   --anchor-lookup $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json\
 *   --golden /tmp/reg/fr-admin-split-golden.jsonl --label v1.5.0 --out /tmp/reg/eval-v150.json
 */

import { dataRootPath, tempRootPath } from "@mailwoman/core/data-root"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { HARD_PLACE_COUNTRY_SAFELIST, hardCountryFor, isBareLocalityTree } from "@mailwoman/core/pipeline"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { percentile } from "@mailwoman/core/stats"
import { mean } from "@mailwoman/core/utils"
import { parseWordConsistencyEnv } from "@mailwoman/neural"
import { stripCombiningMarks } from "@mailwoman/normalize"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { haversineKm } from "@mailwoman/spatial"
import { PathBuilder } from "path-ts"
import { JSONSpliterator, TextSpliterator } from "spliterator"

import { $public } from "#env"
import { collectResolved, type Resolved } from "#tools/eval-harness/oa/resolver/tree-hits"

/**
 * Longest predicted region string still plausibly a code rather than a spelled-out name.
 */
const MAX_REGION_CODE_LENGTH = 4

const { values: args } = parseArguments({
	options: {
		"anchor-lookup": { type: "string" },
		"default-country": { type: "string" },
		"dump-rows": { type: "string" },
		golden: { type: "string" },
		label: { type: "string" },
		model: { type: "string" },
		"model-card": { type: "string" },
		out: { type: "string" },
		tokenizer: { type: "string" },
		"wof-db": { type: "string" },
		// Tri-state pins.
		// The positive flag pins a behavior on.
		// The `--no-*`/inverse flag pins it off.
		// That was the historical config.
		// No flag leaves the current library default.
		// Pin explicitly in pre-registered legs.
		// Official-language names join the name-exact sub-tier (library default on).
		"official-name-exact": { type: "boolean" },
		"admin-coherence": { type: "boolean" },
		"no-admin-coherence": { type: "boolean" },
		"normalize-case": { type: "boolean" },
		"raw-case": { type: "boolean" },
		// Opt-in postcodeConsistency (the namesake binder).
		"postcode-consistency": { type: "boolean" },
		// Postal-compound recovery (library default on).
		"postal-compound-recovery": { type: "boolean" },
		"no-postal-compound-recovery": { type: "boolean" },
		// Apply the production scoping geocode-core does: coarse-placer anchorPosterior
		// re-rank plus the hard-country filter, on top of the soft `--default-country`.
		// Without it the harness overstates the wrong-country p90 tail for namesake locales.
		"hard-country": { type: "boolean" },
		// Comma-separated country codes to add to the default hard-country safelist
		// for this run (e.g. `--hard-country-safelist HU`).
		// Measures a proposed safelist expansion without touching the production const.
		// The p90 of a cross-border-tail country should collapse if it's added.
		"hard-country-safelist": { type: "string" },
		// Convention epoch 2026-07-04: locality-first is the default (production's ladder).
		// This flag reproduces the pre-epoch postcode-point convention for continuity against old dumps only.
		"prefer-postcode-coord": { type: "boolean" },
		// Pre-epoch spelling, accepted so in-flight scripts do not silently change convention.
		// It is the default now, so it is a no-op.
		"prefer-locality-coord": { type: "boolean" },
	},
	allowPositionals: true,
})

/**
 * Convention epoch 2026-07-04 (operator-promoted): the default scoring coordinate is the one
 * production's result-assembly ladder picks, locality over postcode (geocode-core `adminPriority`).
 *
 * All dumps before this epoch are postcode-convention: never compare across
 * conventions (the tokenizer-F1 rule, coordinate edition).
 *
 * `--prefer-postcode-coord` reproduces the old convention for continuity runs only.
 *
 * Do not "align" this table to `PLACETYPE_SPECIFICITY`.
 * That scale ranks `postalcode` above `locality`.
 *
 * This convention rejects that preference.
 * A specificity scale would reinstate it.
 *
 * The deeper mismatch is that production has no single ranking to copy: `geocode-core`'s `adminPriority`
 * switches per row, leading with `postcode` only when `isUnitGradePostcodeHit` identifies the
 * code as street-block-class (a GB unit postcode, an NL PC6) and with `locality` otherwise.
 * This table is the second arm, flattened.
 *
 * It gives the right result for the FR rows it grades.
 * It never sees a GB unit-postcode row.
 *
 * Both arms now consume `@mailwoman/resolver`'s conditional `resolvedSpecificity`.
 * This table is the last flat copy left.
 *
 * It differs on one axis: it ranks `postalcode` (5) above `localadmin`/`borough` (4), where the
 * shared scale puts an area-grade code below the whole `PLACETYPE_FILTER_GROUPS.locality` tier.
 *
 * A migration changes this eval's verdict on any row that resolves a `localadmin`
 * or `borough`, so it needs that count on this eval's own panel first.
 * A promoted convention does not move on an argument.
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

/**
 * The pre-epoch (postcode-point) convention, for continuity runs against pre-2026-07-04 dumps only.
 */
const POSTCODE_CONVENTION_RANK: Record<string, number> = { ...PLACETYPE_RANK, postalcode: 6, locality: 5 }

/**
 * Keep this helper local instead of using tree-hits' `mostSpecific`.
 *
 * That function delegates to the production conditional ladder (`mostSpecificResolved`).
 * This eval grades against the flat convention tables above.
 *
 * See the `PLACETYPE_RANK` docstring for why migrating needs a panel count first.
 */
function mostSpecific(rs: Resolved[], rank: Record<string, number> = PLACETYPE_RANK): Resolved | null {
	let best: Resolved | null = null

	for (const r of rs)
		if (!best || (rank[r.placetype] ?? -1) > (rank[best.placetype] ?? -1)) {
			best = r
		}

	return best
}

const norm = (s: string | null): string =>
	stripCombiningMarks(s ?? "")
		.toLowerCase()
		.trim()

const FR_CENTROID = { lat: 46.6, lon: 2.5 }

async function main() {
	const goldenPath = args["golden"] || tempRootPath("reg", "fr-admin-split-golden.jsonl")
	const label = args["label"] || "model"
	// Comma-separated multi-extract support: postcodeConsistency needs a resolvable postcode node.
	// That requires a postalcode extract alongside the admin DB.
	const wofDBArg = PathBuilder.from(args["wof-db"] || wofDatabasePath("admin-global-priority.db"))
	const wofDB = wofDBArg.includes(",") ? wofDBArg.split(",") : wofDBArg

	const [{ WOFSQLitePlaceLookup }, { createScorer }, { createWOFResolver }, { loadDefaultPlaceCountry }] =
		await Promise.all([
			import("@mailwoman/resolver-wof-sqlite"),
			import("@mailwoman/neural/scorer"),
			import("@mailwoman/resolver"),
			import("#index"),
		])

	const anchorPath = args["anchor-lookup"] || dataRootPath("anchor", "pilot-anchor-lookup.json")

	const neural = await createScorer({
		modelPath: args["model"] || "",
		tokenizerPath: args["tokenizer"] || "",
		modelCardPath: args["model-card"] || "",
		...(anchorPath ? { anchorLookupPath: anchorPath } : {}),
		strict: true,
		tier: "server",
	})

	const tri = (on: keyof typeof args, off: keyof typeof args): boolean | undefined =>
		args[on] === true ? true : args[off] === true ? false : undefined

	const officialNameExact = args["official-name-exact"] === true

	const resolver = createWOFResolver(
		new WOFSQLitePlaceLookup({ databasePath: wofDB }, officialNameExact ? { officialNameExact } : undefined)
	)

	const adminCoherencePin = tri("admin-coherence", "no-admin-coherence")
	const normalizeCasePin = tri("normalize-case", "raw-case")
	const postcodeConsistencyPin = args["postcode-consistency"] === true ? true : undefined
	const postalCompoundPin = tri("postal-compound-recovery", "no-postal-compound-recovery")
	// `--default-country none` = truly unscoped resolution (no country prior at all).
	// The namesake legs need it.
	// An empty string would still be a (falsy, ambiguous) country value.
	const defaultCountryArg = args["default-country"] || "FR"

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

	// When `--hard-country` is set, load the bundled coarse placer and apply the same scoping
	// geocode-core does per row (anchorPosterior + anchorWeight + the hard-country filter).
	// This makes the harness's absolute p90s production-equivalent for namesake locales.
	// `hardCountryFor` is a no-op when defaultCountry is set (the caller's country wins),
	// so the hard filter only bites the unscoped `--default-country none` legs,
	// exactly matching geocode-core's precedence.
	const hardCountryPin = args["hard-country"] === true
	const placeCountry = hardCountryPin ? await loadDefaultPlaceCountry() : null
	const COARSE_PLACER_ANCHOR_WEIGHT = 1

	// keep in sync with geocode-core.ts: default safelist + any `--hard-country-safelist`
	// additions (experiment without editing the const).
	const extraSafelist = args["hard-country-safelist"]
		? TextSpliterator.from(args["hard-country-safelist"], { delimiter: "," })
				.map((c) => c.toUpperCase())
				.toArray()
		: undefined

	const hardCountrySafelist = extraSafelist?.length
		? new Set([...HARD_PLACE_COUNTRY_SAFELIST, ...extraSafelist])
		: undefined

	const errs: number[] = []
	const resolvedErrs: number[] = [] // coordinate error over RESOLVED rows only (unconfounded by the unresolved penalty)
	// Per-row records for a paired A/B bootstrap (--dump-rows): index-aligned across
	// model runs on the same golden, so coord-ab-bootstrap.ts can resample rows
	// and compute a paired p50-diff / resolve-rate CI.
	const rowRecords: Array<{ i: number; resolved: boolean; err_km: number | null }> = []
	let rowIdx = -1

	let resolved = 0,
		regionEmitted = 0,
		regionCorrect = 0,
		diacriticBroken = 0,
		hasGoldRegion = 0

	for await (const row of JSONSpliterator.fromAsync<{
		raw: string
		components?: Record<string, string>
		lat: number
		lon: number
	}>(goldenPath)) {
		rowIdx++

		const tree = await neural.parse(row.raw, {
			postcodeRepair: true,
			enforceWordConsistency: parseWordConsistencyEnv($public.MAILWOMAN_WORD_CONSISTENCY ?? null),
			...(normalizeCasePin !== undefined ? { normalizeCase: normalizeCasePin } : {}),
		})

		const flat = decodeAsJSON(tree) as Record<string, string>
		const goldRegion = row.components?.region as string | undefined
		const predRegion = flat.region

		if (goldRegion) {
			hasGoldRegion++

			if (predRegion) {
				regionEmitted++

				if (norm(predRegion) === norm(goldRegion)) {
					regionCorrect++
				}
				// A broken diacritic subword: pred is a strict, shorter suffix of gold ("ère" of "Lozère").
				else if (
					goldRegion.length > predRegion.length &&
					norm(goldRegion).endsWith(norm(predRegion)) &&
					predRegion.length <= MAX_REGION_CODE_LENGTH
				) {
					diacriticBroken++
				}
			}
		}

		// Mirror geocode-core's per-row scoping when `--hard-country`: coarse placer,
		// anchorPosterior re-rank, plus a hard-country filter on the unscoped legs.
		// The placer abstains on a bare-locality tree (same isBareLocalityTree guard geocode-core uses),
		// and hardCountryFor no-ops when defaultCountry set.
		let rowResolveOpts = resolveOpts

		if (placeCountry && !isBareLocalityTree(tree)) {
			const placed = placeCountry(row.raw)

			if (placed.country && placed.country !== "OTHER") {
				const hardCountry = hardCountryFor(placed.country, placed.confidence, resolveOpts, true, hardCountrySafelist)

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
			args["prefer-postcode-coord"] === true ? POSTCODE_CONVENTION_RANK : PLACETYPE_RANK
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

	const n = rowIdx + 1

	const summary = {
		label,
		n,
		coord_mean_km: +(mean(errs) ?? Number.NaN).toFixed(2),
		coord_p50_km: +(percentile(errs, 50) ?? Number.NaN).toFixed(2),
		coord_p90_km: +(percentile(errs, 90) ?? Number.NaN).toFixed(2),
		// resolved-only coordinate: the quality where the address resolves, separated from the
		// unresolved penalty (which pins to FR_CENTROID and is meaningless for non-FR locales).
		coord_p50_resolved_km: resolvedErrs.length ? +(percentile(resolvedErrs, 50) ?? Number.NaN).toFixed(2) : null,
		coord_p90_resolved_km: resolvedErrs.length ? +(percentile(resolvedErrs, 90) ?? Number.NaN).toFixed(2) : null,
		resolve_rate: +(resolved / n).toFixed(4),
		region_emit_rate: hasGoldRegion ? +(regionEmitted / hasGoldRegion).toFixed(4) : null,
		region_correct_rate: hasGoldRegion ? +(regionCorrect / hasGoldRegion).toFixed(4) : null,
		diacritic_broken: diacriticBroken,
		gold_region_rows: hasGoldRegion,
	}

	console.log(prettyJSON(summary, false))

	const outPath = args["out"] || ""

	if (outPath) {
		await writeLocalJSONFile(summary, outPath)

		console.error(`wrote ${outPath}`)
	}

	// Per-row dump for the paired A/B bootstrap.
	// One JSON line per golden row, index-aligned to the input.
	const dumpPath = args["dump-rows"] || ""

	if (dumpPath) {
		await writeLocalJSONLFile(rowRecords, dumpPath)

		console.error(`wrote per-row dump: ${dumpPath} (${rowRecords.length} rows)`)
	}
}

await main()
