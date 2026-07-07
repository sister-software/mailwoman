#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #825 ORACLE-LOCALITY INJECTION (night 2026-06-28, Phase D) — go/no-go for a future GPU parse
 *   retrain. For each non-US golden address we compare two resolutions against the SAME gazetteer:
 *
 *   - ORIGINAL — the shipped model parses `raw`, then resolve → coordinate. (What we ship today; the
 *     night-22 panel measured PT/PL ~52%, AU ~28% resolve.)
 *   - ORACLE   — skip the model: resolve the GOLD locality directly (`backend.findPlace`), the
 *     best-case "perfect parse." The gap ORACLE − ORIGINAL is the model parse's contribution.
 *
 *   GO (parse is the bottleneck → a retrain earns GPU): ORACLE resolve-rate ≫ ORIGINAL AND the oracle
 *   coordinate is tight. NO-GO (coverage is the bottleneck): ORACLE barely beats ORIGINAL — a perfect
 *   parse still doesn't resolve, so the gazetteer is the gap, redirect to data work.
 *
 *   Resolves against `$MAILWOMAN_CANDIDATE_DB` if set (the post-B world) else the admin shards. PT/PL/AU
 *   are in the already-covered set, so the staged-B gazetteer == canonical for them (B added disjoint
 *   countries) — run once against staged-B and note the equality. CPU-only; --expose-gc for the leak.
 *
 *   Run: node --expose-gc scripts/eval/oracle-locality-injection.ts --golden <jsonl> --label pt
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { createResolverBackend, mailwomanDataRoot, wofShardPaths } from "mailwoman/resolver-backend"

import { arg } from "../lib/cli-args.ts"

const GOLDEN = arg("golden", "")
const LABEL = arg("label", "")
const OUT = arg("out", "")

if (!GOLDEN || !existsSync(GOLDEN)) {
	console.error(`--golden <jsonl> required (got ${GOLDEN})`)
	process.exit(1)
}

const gc = (globalThis as { gc?: () => void }).gc

if (typeof gc !== "function") {
	console.error("Run with --expose-gc (the onnxruntime batch leak SIGKILLs otherwise).")
	process.exit(1)
}

interface GoldenRow {
	raw: string
	components: { house_number?: string; street?: string; postcode?: string; locality?: string }
	country: string
	lat: number
	lon: number
}

const rows: GoldenRow[] = readFileSync(GOLDEN, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as GoldenRow)

const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const backend = createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) })
const resolver = createWOFResolver(backend)
const shards = new ShardProvider(resolverMod, mailwomanDataRoot())

const pct = (xs: number[], p: number): number => {
	if (!xs.length) return NaN
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

let origResolved = 0
let oracleResolved = 0
const origErrs: number[] = []
const oracleErrs: number[] = []
let done = 0

for (const r of rows) {
	const country = r.country

	// ORIGINAL — shipped model parse → resolve.
	try {
		const g = await geocodeAddress(r.raw, { classifier, resolver, shards: shards.for, defaultCountry: country })

		if (g.lat != null && g.lon != null) {
			origResolved++
			origErrs.push(haversineKm(g.lat, g.lon, r.lat, r.lon))
		}
	} catch {
		/* unresolved */
	}

	// ORACLE — resolve the GOLD locality directly (best-case parse).
	const loc = r.components.locality?.trim()

	if (loc) {
		const hits = await backend.findPlace({
			text: loc,
			country,
			postcode: r.components.postcode?.trim(),
			placetype: "locality",
			limit: 5,
		})
		const best = hits.find((h) => h.lat !== 0 || h.lon !== 0)

		if (best) {
			oracleResolved++
			oracleErrs.push(haversineKm(best.lat, best.lon, r.lat, r.lon))
		}
	}

	if (++done % 25 === 0) {
		gc()
	}
}

const n = rows.length
const origRate = (100 * origResolved) / n
const oracleRate = (100 * oracleResolved) / n
const lift = oracleRate - origRate
const recovered = oracleResolved - origResolved
const closedShare = n - origResolved > 0 ? (100 * recovered) / (n - origResolved) : 0
// PRIMARY signal = the assembled COORDINATE (the project directive — never grade on resolve-rate alone).
// A perfect parse can recover RECALL (resolves more) OR ACCURACY (resolves the SAME rate but to the
// right town instead of a same-name namesake). Both justify a parse retrain.
const origP50 = origErrs.length ? pct(origErrs, 50) : Infinity
const oracleP50 = oracleErrs.length ? pct(oracleErrs, 50) : Infinity
const deltaP50Rel = Number.isFinite(origP50) && origP50 > 0 ? (100 * (origP50 - oracleP50)) / origP50 : 0
// GO: a perfect parse materially improves the coordinate (Δp50 ≥ 20% OR recall closes ≥ half the gap)
// AND the oracle coordinate is tight (proving the gazetteer HAS the answer — so it's parse, not coverage).
const oracleTight = Number.isFinite(oracleP50) && oracleP50 < 25
const go = oracleTight && (deltaP50Rel >= 20 || closedShare >= 50)

const L: string[] = []
L.push(`# #825 oracle-locality injection — ${LABEL || GOLDEN} (${go ? "GO" : "NO-GO"})`)
L.push("")
L.push(`_Gazetteer: ${process.env["MAILWOMAN_CANDIDATE_DB"] ?? "admin shards"}. n=${n}._`)
L.push(`_ORIGINAL = shipped model parse → resolve. ORACLE = gold locality resolved directly (perfect parse)._`)
L.push("")
L.push(
	`- ORIGINAL resolve-rate: **${origRate.toFixed(1)}%** (${origResolved}/${n}) — p50 ${origErrs.length ? pct(origErrs, 50).toFixed(1) : "—"} km, p90 ${origErrs.length ? pct(origErrs, 90).toFixed(1) : "—"} km`
)
L.push(
	`- ORACLE resolve-rate: **${oracleRate.toFixed(1)}%** (${oracleResolved}/${n}) — p50 ${oracleErrs.length ? pct(oracleErrs, 50).toFixed(1) : "—"} km, p90 ${oracleErrs.length ? pct(oracleErrs, 90).toFixed(1) : "—"} km`
)
L.push(
	`- RECALL: lift **+${lift.toFixed(1)} pp**, a perfect parse closes **${closedShare.toFixed(0)}%** of the unresolved`
)
L.push(
	`- ACCURACY (resolved p50): **${Number.isFinite(origP50) ? origP50.toFixed(1) : "—"} km → ${Number.isFinite(oracleP50) ? oracleP50.toFixed(1) : "—"} km** with a perfect parse (**Δp50 ${deltaP50Rel.toFixed(0)}%**)`
)
L.push("")
L.push(
	go
		? `## GO — parse is the dominant bottleneck. A perfect locality ${deltaP50Rel >= 20 ? `tightens the coordinate ${Number.isFinite(origP50) ? origP50.toFixed(1) : "—"}→${oracleP50.toFixed(1)} km (Δp50 ${deltaP50Rel.toFixed(0)}%)` : `recovers ${closedShare.toFixed(0)}% of the unresolved`}, and the oracle coordinate is tight (the gazetteer HAS the answer). A multilocale parse retrain (#825) earns a future GPU shift for this locale.`
		: `## NO-GO — a perfect parse does NOT materially improve the coordinate (Δp50 ${deltaP50Rel.toFixed(0)}%, recall closes ${closedShare.toFixed(0)}%${oracleTight ? "" : "; oracle coordinate also loose → gazetteer coverage, not parse"}). Redirect to B-style data work; do not spend GPU on #825 for this locale.`
)

const report = L.join("\n")
console.log(report)

if (OUT) {
	writeFileSync(OUT, `${report}\n`)
	console.error(`[oracle] wrote ${OUT}`)
}
