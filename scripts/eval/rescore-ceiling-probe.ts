import { existsSync, readFileSync } from "node:fs"

/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   #370 RESCORE-CEILING probe — sizes how much of the unresolved tail a parse<->resolve rescoring
 *   loop could recover, vs a true gazetteer coverage gap. For each coord-golden row: parse (the shipped
 *   v4.13.0 model) -> resolveTree -> resolved? For each UNRESOLVED row, ask whether the GOLD locality is
 *   in the gazetteer (findPlace) and what the model emitted, and bucket the failure:
 *     - swap     : gold IS in the gazetteer AND the model emitted a DIFFERENT (wrong) locality token
 *                  -> a constrained rescore that swaps in the gold token recovers it. The clearest #370 win.
 *     - needsK   : gold IS in the gazetteer AND the model emitted NO locality -> only a K-best decode
 *                  that surfaces the gold token could recover it (harder).
 *     - emitUnres: model emitted the gold locality but resolveTree still didn't resolve -> a resolver
 *                  ranking/country-filter issue, NOT a rescore opportunity.
 *     - covGap   : gold NOT in the gazetteer -> rescoring can't help; it's a coverage gap.
 *   recoverable = swap + needsK = #370's CEILING. Same resolver for baseline + gold-check (consistent).
 *
 *   Run: node --experimental-strip-types scripts/eval/rescore-ceiling-probe.ts [--model out/v191/model.onnx] [--n 150]
 */
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../lib/cli-args.ts"

const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const CARD = "neural-weights-en-us/model-card.json"
const ANCHOR = dataRootPath("anchor", "pilot-anchor-lookup.json")
const WOF = dataRootPath("wof", "admin-global-priority.db")
const MODEL = arg("model", "out/v191/model.onnx")
const N = Number(arg("n", "150"))
const LOCALES: [string, string][] = [
	["IT", "data/eval/external/oa-it-coord-150.jsonl"],
	["PT", "data/eval/external/oa-pt-coord-150.jsonl"],
	["PL", "data/eval/external/oa-pl-coord-150.jsonl"],
	["AT", "data/eval/external/oa-at-coord-150.jsonl"],
	["CZ", "data/eval/external/oa-cz-coord-150.jsonl"],
	["FR", "data/eval/external/oa-fr-coord-150.jsonl"],
	["AU", "data/eval/external/oa-au-coord-150.jsonl"],
]

type N9 = { placeID?: string; children?: unknown[] }
const hasWOF = (n: N9): boolean => !!n.placeID?.startsWith("wof:") || ((n.children as N9[]) ?? []).some(hasWOF)

const pctile = (xs: number[], p: number): number => {
	if (!xs.length) return NaN
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

async function main() {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WOFSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new WOFSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWOFResolver(lookup as never)
	const model = await createScorer({
		modelPath: MODEL,
		tokenizerPath: TOK,
		modelCardPath: CARD,
		anchorLookupPath: ANCHOR,
		strict: true,
		tier: "server",
	})

	console.log(`loc | n   res  unres | swap needsK emitUnres covGap | swapKm p50/p90 (top1·best5)`)
	const T = { n: 0, res: 0, unres: 0, swap: 0, needsK: 0, emitUn: 0, cov: 0 }
	// FALSIFIER accumulators: great-circle error (km) from the postcode-disambiguated gold-locality
	// resolution to truth, over the swap cases. top1 = resolver's ranked choice; best5 = the ceiling
	// if same-name disambiguation picks the right candidate from the top 5.
	const swapTop1: number[] = []
	const swapBest5: number[] = []

	for (const [cc, file] of LOCALES) {
		if (!existsSync(file)) {
			console.log(`${cc}: golden missing — skipped`)
			continue
		}
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.slice(0, N)
			.map((l) => JSON.parse(l))
		const s = { n: 0, res: 0, unres: 0, swap: 0, needsK: 0, emitUn: 0, cov: 0 }
		const sT1: number[] = []
		const sB5: number[] = []

		for (const row of rows) {
			s.n++
			const tree = await model.parse(row.raw, { postcodeRepair: true })
			const r = await resolver.resolveTree(tree as never, { defaultCountry: cc })

			if ((r.roots as N9[]).some(hasWOF)) {
				s.res++
				continue
			}
			s.unres++
			const emitted = ((decodeAsJSON(tree) as Record<string, string>).locality ?? "").toString().trim()
			const gold = ((row.components?.locality as string) ?? "").toString().trim()
			const goldCands = gold ? await lookup.findPlace({ text: gold, country: cc, limit: 5 }) : []

			if (goldCands.length === 0) {
				s.cov++
			} else if (emitted && emitted.toLowerCase() !== gold.toLowerCase()) {
				s.swap++
				// FALSIFIER: resolve the gold locality with the row's postcode (what the rescore keeps as
				// an anchor) and measure great-circle to truth. p50 < 10km → the swap recovers a REAL
				// coordinate; scatter → the gold name resolves to a same-name collision (a label-F1 mirage,
				// the #685 trap). (0,0) placeholders are dropped — WOF ships them on some rows.
				const tLat = Number(row.lat),
					tLon = Number(row.lon)

				if (Number.isFinite(tLat) && Number.isFinite(tLon)) {
					const pc = ((row.components?.postcode ?? row.components?.postal_code ?? "") as string).toString().trim()
					const dis = pc ? await lookup.findPlace({ text: gold, country: cc, postcode: pc, limit: 5 }) : goldCands
					// findPlace candidates carry lat/lon (NOT the ResolvedPlace latitude/longitude).
					const dists = (dis as unknown as { lat: number; lon: number }[])
						.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && (c.lat !== 0 || c.lon !== 0))
						.map((c) => haversineKm(tLat, tLon, c.lat, c.lon))

					if (dists.length) {
						sT1.push(dists[0]!)
						sB5.push(Math.min(...dists))
					}
				}
			} else if (!emitted) {
				s.needsK++
			} else {
				s.emitUn++
			}
		}
		const swapKm =
			sT1.length > 0
				? `${pctile(sT1, 50).toFixed(1)}/${pctile(sT1, 90).toFixed(0)} · ${pctile(sB5, 50).toFixed(1)}/${pctile(sB5, 90).toFixed(0)} (n${sT1.length})`
				: "—"
		console.log(
			`${cc.padEnd(3)} | ${String(s.n).padEnd(3)} ${String(s.res).padEnd(3)}  ${String(s.unres).padEnd(4)} | ${String(s.swap).padEnd(3)}  ${String(s.needsK).padEnd(5)}  ${String(s.emitUn).padEnd(8)}  ${String(s.cov).padEnd(2)} | ${swapKm}`
		)

		for (const k of Object.keys(s) as (keyof typeof s)[]) {
			T[k] += s[k]
		}
		swapTop1.push(...sT1)
		swapBest5.push(...sB5)
	}
	const recoverable = T.swap + T.needsK
	console.log(`ALL | n=${T.n} res=${T.res} unres=${T.unres}`)
	console.log(
		`\n#370 CEILING: of ${T.unres} unresolved → recoverable (gold-in-gazetteer) = ${recoverable} ` +
			`(${((100 * recoverable) / Math.max(T.unres, 1)).toFixed(0)}% of the tail) [swap=${T.swap}, needsK=${T.needsK}]\n` +
			`              emitted-but-unresolved (resolver-side) = ${T.emitUn}\n` +
			`              coverage-gap (rescore can't help)      = ${T.cov} (${((100 * T.cov) / Math.max(T.unres, 1)).toFixed(0)}%)`
	)
	// FALSIFIER VERDICT (DeepSeek-specified): does the gold-locality swap recover a REAL coordinate?
	const t1p50 = pctile(swapTop1, 50),
		t1p90 = pctile(swapTop1, 90),
		b5p50 = pctile(swapBest5, 50),
		b5p90 = pctile(swapBest5, 90)
	const verdict =
		swapTop1.length === 0
			? "INCONCLUSIVE — no swap cases with a truth coord + resolvable gold"
			: t1p50 < 10
				? "PASS (top-1) — the postcode-disambiguated gold locality lands <10 km p50; build the span-rescore"
				: b5p50 < 10
					? "PASS (best-5 only) — the right candidate is in the top 5 but ranking misses it; the rescore NEEDS the postcode-anchor disambiguation, not just the name swap"
					: "FAIL — gold name resolves far from truth (same-name-collision mirage / #685 trap); a bare span-rescore would chase label-F1, not coordinates"
	console.log(
		`\n#370 FALSIFIER (swap-case gold→truth great-circle, n=${swapTop1.length}):\n` +
			`   top-1 (resolver-ranked, postcode-disambiguated): p50 ${t1p50.toFixed(1)} km · p90 ${t1p90.toFixed(0)} km\n` +
			`   best-of-5 (ceiling if disambiguation is perfect):  p50 ${b5p50.toFixed(1)} km · p90 ${b5p90.toFixed(0)} km\n` +
			`   → ${verdict}`
	)
}
await main()
