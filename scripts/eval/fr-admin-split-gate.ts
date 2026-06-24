/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fr-admin-split-gate.ts — the LIVE gate for the v1.8.0 international admin-split candidate (night
 *   2026-06-19). Runs the production ship-config parse (createScorer: anchor + gazetteer +
 *   conventions=auto) → resolve (createWofResolver, defaultCountry FR) → coordinate on the HELD-OUT
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
 *   --anchor-lookup /mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json\
 *   --golden /tmp/reg/fr-admin-split-golden.jsonl --label v1.5.0 --out /tmp/reg/gate-v150.json
 */

import { type AddressNode, type AddressTree, decodeAsJson } from "@mailwoman/core/decoder"
import { createWofResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { readFileSync, writeFileSync } from "node:fs"

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
		if (n.placeId?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceId ?? "").split(":")[0] ?? ""
			out.push({
				id: Number(n.placeId.slice(4)),
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
const norm = (s: string | undefined): string => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

const arg = (k: string, d = ""): string => {
	const i = process.argv.indexOf(`--${k}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}

const FR_CENTROID = { lat: 46.6, lon: 2.5 }

async function main() {
	const goldenPath = arg("golden", "/tmp/reg/fr-admin-split-golden.jsonl")
	const label = arg("label", "model")
	const wofDb = arg("wof-db", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
	const rows = readFileSync(goldenPath, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l))

	const { createScorer } = await import("@mailwoman/neural/scorer")
	const anchorPath = arg("anchor-lookup", "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json")
	const neural = await createScorer({
		modelPath: arg("model"),
		tokenizerPath: arg("tokenizer"),
		modelCardPath: arg("model-card"),
		...(anchorPath ? { anchorLookupPath: anchorPath } : {}),
		strict: true,
		tier: "server",
	})
	const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const resolver = createWofResolver(new WofSqlitePlaceLookup({ databasePath: wofDb }) as never)
	const resolveOpts = { defaultCountry: arg("default-country", "FR") }

	const errs: number[] = []
	const resolvedErrs: number[] = [] // coordinate error over RESOLVED rows only (unconfounded by the unresolved penalty)
	let resolved = 0,
		regionEmitted = 0,
		regionCorrect = 0,
		diacriticBroken = 0,
		hasGoldRegion = 0
	for (const row of rows) {
		const tree = await neural.parse(row.raw, {
			postcodeRepair: true,
			enforceWordConsistency: process.env.MAILWOMAN_WORD_CONSISTENCY === "1",
		})
		const flat = decodeAsJson(tree) as Record<string, string>
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
		} else {
			errs.push(haversineKm(FR_CENTROID.lat, FR_CENTROID.lon, row.lat, row.lon))
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
}

await main()
