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

import { type AddressNode, type AddressTree, decodeAsJSON } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { dataRootPath } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../lib/cli-args.ts"

const PLACETYPE_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	country: 0,
}
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
function mostSpecific(rs: Resolved[]): Resolved | null {
	let best: Resolved | null = null

	for (const r of rs)
		if (!best || (PLACETYPE_RANK[r.placetype] ?? -1) > (PLACETYPE_RANK[best.placetype] ?? -1)) best = r

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

	const [{ WOFSqlitePlaceLookup }, { createScorer }, { createWOFResolver }] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite"),
		import("@mailwoman/neural/scorer"),
		import("@mailwoman/resolver"),
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
	const resolver = createWOFResolver(new WOFSqlitePlaceLookup({ databasePath: wofDB }) as never)
	// #895: the library defaults flipped ON (drift D1/D2). Tri-state pins keep gate legs reproducible
	// against pre-flip baselines: `--no-admin-coherence`/`--raw-case` reproduce the historical config,
	// no flag = the current library default. Pin explicitly in pre-registered legs (#718 discipline).
	const adminCoherencePin = process.argv.includes("--admin-coherence")
		? true
		: process.argv.includes("--no-admin-coherence")
			? false
			: undefined
	const normalizeCasePin = process.argv.includes("--normalize-case")
		? true
		: process.argv.includes("--raw-case")
			? false
			: undefined
	// #375 night-31: opt-in postcodeConsistency pin (the #370 lever A namesake binder) for the
	// taxonomy-driven experiment; unset = library default (off).
	const postcodeConsistencyPin = process.argv.includes("--postcode-consistency") ? true : undefined
	const resolveOpts = {
		defaultCountry: arg("default-country", "FR"),
		...(adminCoherencePin !== undefined ? { adminCoherence: adminCoherencePin } : {}),
		...(postcodeConsistencyPin !== undefined ? { postcodeConsistency: postcodeConsistencyPin } : {}),
	}

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
		const best = mostSpecific(collectResolved(await resolver.resolveTree(tree, resolveOpts)))

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
