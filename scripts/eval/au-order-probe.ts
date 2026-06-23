/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   AU word-order ceiling probe. The AU OpenAddresses rows are written postcode-first / house-number-
 *   last ("3053 Carlton, Barry Street 50"); the model — trained on house-number-first / postcode-last
 *   formats — mis-segments them (swaps postcode↔house_number and street↔locality), and resolution
 *   collapses. The model parses the SAME addresses correctly when reordered to canonical order, so AU
 *   is a format-ORDER coverage gap (the German v0.9.2 artifact again), not a capability/gazetteer gap.
 *
 *   This quantifies the ceiling: resolve the AU panel as-written vs reordered-to-canonical, @25km. The
 *   reordered number is what AU-native-order training data (#208 G-NAF) should unlock — no resolver
 *   trick, the model already knows these places.
 *
 *   Run: node --experimental-strip-types scripts/eval/au-order-probe.ts --candidate-db <db> [--n 60]
 */
import type { AddressNode, AddressTree } from "@mailwoman/core/resolver"
import { createWofResolver } from "@mailwoman/core/resolver"
import { existsSync, readFileSync } from "node:fs"

const arg = (k: string, d = ""): string => {
	const i = process.argv.indexOf(`--${k}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const CAND = arg("candidate-db", "/mnt/playpen/mailwoman-data/wof/candidate-global-20j.db")
const N = Number(arg("n", "60"))

/**
 * Reorder an AU postcode-first row to canonical (street, suburb postcode). Two native shapes: "PPPP
 * Suburb, Street HN" → "Street HN, Suburb PPPP" "Suburb, PPPP, Street HN" → "Street HN, Suburb
 * PPPP" Anything else is left as-written (already canonical-ish, or unrecognized).
 */
function toCanonical(raw: string): string {
	let m = raw.match(/^\s*(\d{4})\s+([^,]+),\s*(.+)$/)
	if (m) return `${m[3].trim()}, ${m[2].trim()} ${m[1]}`
	m = raw.match(/^\s*([^,]+),\s*(\d{4}),\s*(.+)$/)
	if (m) return `${m[3].trim()}, ${m[1].trim()} ${m[2]}`
	return raw
}

const haversineKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
	const R = 6371
	const dLat = ((b.lat - a.lat) * Math.PI) / 180
	const dLon = ((b.lon - a.lon) * Math.PI) / 180
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
	return 2 * R * Math.asin(Math.sqrt(h))
}
const RANK: Record<string, number> = {
	country: 0,
	region: 1,
	county: 3,
	localadmin: 4,
	locality: 5,
	neighbourhood: 7,
	street: 9,
	address: 10,
}
function bestCoord(tree: AddressTree): { lat: number; lon: number } | null {
	let best: { lat: number; lon: number; r: number } | null = null
	const visit = (n: AddressNode): void => {
		const pt = String(n.sourceId ?? "").split(":")[0] ?? ""
		if (n.placeId?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined && (n.lat !== 0 || n.lon !== 0)) {
			const r = RANK[pt] ?? 5
			if (!best || r > best.r) best = { lat: n.lat, lon: n.lon, r }
		}
		for (const c of n.children ?? []) visit(c)
	}
	for (const r of tree.roots) visit(r)
	return best ? { lat: best.lat, lon: best.lon } : null
}

async function main() {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WofCandidateTableLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const resolver = createWofResolver(new WofCandidateTableLookup({ databasePath: CAND }) as never)
	const model = await createScorer({
		modelPath: "out/v191/model.onnx",
		tokenizerPath: "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model",
		modelCardPath: "neural-weights-en-us/model-card.json",
		anchorLookupPath: "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json",
		strict: true,
		tier: "server",
	})
	const file = "data/eval/external/oa-au-coord-150.jsonl"
	if (!existsSync(file)) throw new Error(`missing ${file}`)
	const rows = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.slice(0, N)
		.map((l) => JSON.parse(l)) as Array<{ raw: string; lat: number; lon: number }>

	let nativeHit = 0,
		canonHit = 0,
		reordered = 0,
		n = 0
	const opts = { defaultCountry: "AU", spanRescore: true, postcodeConsistency: true } as never
	for (const row of rows) {
		const truth = { lat: row.lat, lon: row.lon }
		n++
		const native = bestCoord(
			(await resolver.resolveTree((await model.parse(row.raw, { postcodeRepair: true })) as never, opts)) as never
		)
		if (native && haversineKm(truth, native) <= 25) nativeHit++
		const canon = toCanonical(row.raw)
		if (canon !== row.raw) reordered++
		const c = bestCoord(
			(await resolver.resolveTree((await model.parse(canon, { postcodeRepair: true })) as never, opts)) as never
		)
		if (c && haversineKm(truth, c) <= 25) canonHit++
	}
	const pct = (x: number) => ((100 * x) / Math.max(n, 1)).toFixed(0)
	console.log(`\nAU word-order ceiling (n=${n}, ${reordered} rows reordered to canonical):`)
	console.log(`  as-written (AU postcode-first):  ${pct(nativeHit)}% @25km`)
	console.log(`  reordered to canonical order:    ${pct(canonHit)}% @25km`)
	console.log(`  → the gap is the upside of AU-native-order training data (#208 G-NAF), no resolver trick.`)
}
await main()
