import { existsSync, readFileSync } from "node:fs"

/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   Failure-mode dump for the competitive panel. For every row mailwoman MISSES (@25km — either a
 *   no-result or a resolved-but-too-far), print the raw input, the truth, what we resolved (if
 *   anything), and the parse breakdown (each tag, its value, whether it resolved to a coordinate).
 *   Auto-classify the cause so the tally points at the next lever instead of a hunch.
 *
 *   No external API — this is mailwoman against itself, so it's free + fast.
 *
 *   Run: node --experimental-strip-types scripts/eval/failure-dump.ts \
 *          --candidate-db $MAILWOMAN_DATA_ROOT/wof/candidate-global-20i.db [--n 60] [--show 10]
 */
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

import { arg } from "../lib/cli-args.ts"

const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const CARD = "neural-weights-en-us/model-card.json"
const ANCHOR = dataRootPath("anchor", "pilot-anchor-lookup.json")
const MODEL = arg("model", "out/v191/model.onnx")
const CAND = arg("candidate-db", dataRootPath("wof", "candidate-global-20i.db"))
const N = Number(arg("n", "60"))
const SHOW = Number(arg("show", "10")) // misses to print per locale
const LOCALES = arg("locales", "it,pt,pl,at,cz,fr,au").split(",")
const PC_CONSISTENCY = process.argv.includes("--postcode-consistency") // #370 Lever A probe

const PLACETYPE_RANK: Record<string, number> = {
	country: 0,
	region: 1,
	macrocounty: 2,
	county: 3,
	localadmin: 4,
	locality: 5,
	borough: 6,
	macrohood: 6,
	neighbourhood: 7,
	microhood: 8,
	street: 9,
	address: 10,
	venue: 10,
}
interface NodeInfo {
	tag: string
	value: string
	resolved: boolean
	placetype: string
}
function walk(tree: AddressTree): { best: { lat: number; lon: number; placetype: string } | null; nodes: NodeInfo[] } {
	let best: { lat: number; lon: number; placetype: string } | null = null
	const nodes: NodeInfo[] = []
	const visit = (n: AddressNode): void => {
		const placetype = String(n.sourceID ?? "").split(":")[0] ?? ""
		const resolved = !!(
			n.placeID?.startsWith("wof:") &&
			n.lat !== undefined &&
			n.lon !== undefined &&
			(n.lat !== 0 || n.lon !== 0)
		)

		if (n.tag) {
			nodes.push({ tag: String(n.tag), value: String(n.value ?? ""), resolved, placetype })
		}

		if (resolved && (!best || (PLACETYPE_RANK[placetype] ?? 5) > (PLACETYPE_RANK[best.placetype] ?? 5))) {
			best = { lat: n.lat!, lon: n.lon!, placetype }
		}

		for (const c of n.children ?? []) {
			visit(c)
		}
	}

	for (const r of tree.roots) {
		visit(r)
	}

	return { best, nodes }
}

/** Classify a miss from the parse + what resolved. */
function classify(nodes: NodeInfo[], best: { placetype: string } | null, dist: number | null): string {
	const has = (t: string) => nodes.some((n) => n.tag === t)
	const resolvedTag = (t: string) => nodes.some((n) => n.tag === t && n.resolved)
	const pc = has("postcode")
	const pcResolved = resolvedTag("postcode")
	const loc = has("locality") || has("city")
	const locResolved = resolvedTag("locality") || resolvedTag("city")

	if (dist !== null && best) {
		// resolved but too far — what placed it, and was it a coarse fallback?
		if (best.placetype === "country" || best.placetype === "region")
			return "WRONG_coarse-only (no locality/postcode resolved → coarse fallback)"

		// Did a postcode ALSO resolve? If so this is lever-A-fixable: prefer/disambiguate by the postcode.
		if (best.placetype !== "postalcode" && pcResolved)
			return "WRONG_locality_postcode-AVAILABLE (lever A: prefer/disambiguate by the resolved postcode)"

		return `WRONG_${best.placetype}_no-postcode (no postcode anchor to disambiguate)`
	}

	// no-result
	if (pc && !pcResolved && !locResolved) return "EMPTY_postcode-parsed-unresolved (coverage gap)"

	if (loc && !locResolved && !pcResolved) return "EMPTY_locality-parsed-unresolved (gazetteer miss / fragmentation)"

	if (!loc && !pc) return "EMPTY_no-place-tag-parsed (parse produced no locality/postcode)"

	return "EMPTY_other"
}

async function main() {
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WOFCandidateTableLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new WOFCandidateTableLookup({ databasePath: CAND })
	const resolver = createWOFResolver(lookup as never)
	const model = await createScorer({
		modelPath: MODEL,
		tokenizerPath: TOK,
		modelCardPath: CARD,
		anchorLookupPath: ANCHOR,
		strict: true,
		tier: "server",
	})

	const globalTally: Record<string, number> = {}

	for (const cc of LOCALES) {
		const file = `data/eval/external/oa-${cc}-coord-150.jsonl`

		if (!existsSync(file)) continue
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.slice(0, N)
			.map((l) => JSON.parse(l)) as Array<{ raw: string; lat: number; lon: number }>
		const tally: Record<string, number> = {}
		const samples: string[] = []

		for (const row of rows) {
			const truth = { lat: row.lat, lon: row.lon }
			const tree = await model.parse(row.raw, { postcodeRepair: true })
			const r = await resolver.resolveTree(tree as never, {
				defaultCountry: cc.toUpperCase(),
				spanRescore: true,
				postcodeConsistency: PC_CONSISTENCY,
			})
			const { best, nodes } = walk(r as never)
			const dist = best ? haversineKm(best.lat, best.lon, truth.lat, truth.lon) : null

			if (dist !== null && dist <= 25) continue // hit — skip
			const cat = classify(nodes, best, dist)
			tally[cat] = (tally[cat] ?? 0) + 1
			globalTally[cat] = (globalTally[cat] ?? 0) + 1

			if (samples.length < SHOW) {
				const parse = nodes.map((n) => `${n.tag}=${JSON.stringify(n.value)}${n.resolved ? "✓" : "✗"}`).join(" ")
				samples.push(
					`  [${cat.split(" ")[0]}] ${JSON.stringify(row.raw)}\n      → ${dist === null ? "NO-RESULT" : dist.toFixed(0) + "km off via " + best!.placetype} | parse: ${parse}`
				)
			}
		}
		console.log(
			`\n=== ${cc.toUpperCase()} misses (${Object.values(tally).reduce((a, b) => a + b, 0)}/${rows.length}) ===`
		)

		for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
			console.log(`  ${v}  ${k}`)
		}

		if (samples.length) {
			console.log(samples.join("\n"))
		}
	}
	console.log(`\n=== ALL-LOCALE failure tally ===`)

	for (const [k, v] of Object.entries(globalTally).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${v}  ${k}`)
	}
}
await main()
