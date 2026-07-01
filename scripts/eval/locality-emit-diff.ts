import { readFileSync } from "node:fs"

/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   #148 diagnostic — dump-and-read why v1.9.0 (multi-locale retrain) REGRESSED EU resolve. For each
 *   golden row, parse with TWO models (baseline + candidate), extract the emitted `locality` span, and
 *   resolve each tree → record whether it resolved + the emitted locality. Lets us SEE whether the
 *   candidate emits a DIFFERENT locality string (grain mismatch) or the SAME string that stopped
 *   resolving (boundary/anchor), or drops the locality entirely. Verify-before-verdict, not assurance.
 *
 *   Run: node --experimental-strip-types scripts/eval/locality-emit-diff.ts \
 *     --base out/v180/model.onnx --cand out/v190-int8/model.onnx \
 *     --golden data/eval/external/oa-pt-coord-150.jsonl --default-country PT --n 30
 */
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { createWOFResolver } from "@mailwoman/resolver"

import { arg } from "../lib/cli-args.ts"

const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const CARD = "neural-weights-en-us/model-card.json"
const ANCHOR = dataRootPath("anchor", "pilot-anchor-lookup.json")
const WOF = dataRootPath("wof", "admin-global-priority.db")

async function main() {
	const n = Number(arg("n", "30"))
	const cc = arg("default-country", "PT")
	const rows = readFileSync(arg("golden"), "utf8")
		.trim()
		.split("\n")
		.slice(0, n)
		.map((l) => JSON.parse(l))
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const { WOFSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const mk = (m: string) =>
		createScorer({
			modelPath: m,
			tokenizerPath: TOK,
			modelCardPath: CARD,
			anchorLookupPath: ANCHOR,
			strict: true,
			tier: "server",
		})
	const base = await mk(arg("base"))
	const cand = await mk(arg("cand"))
	const resolver = createWOFResolver(new WOFSqlitePlaceLookup({ databasePath: WOF }) as never)
	const opts = { defaultCountry: cc }
	const didResolve = async (tree: unknown): Promise<boolean> => {
		const r = await resolver.resolveTree(tree as never, opts)
		const has = (n: { placeID?: string; children: unknown[] }): boolean =>
			!!n.placeID?.startsWith("wof:") || (n.children as { placeID?: string; children: unknown[] }[]).some(has)

		return (r.roots as { placeID?: string; children: unknown[] }[]).some(has)
	}

	let diff = 0,
		baseRes = 0,
		candRes = 0,
		candLostThatBaseHad = 0

	for (const row of rows) {
		const bt = await base.parse(row.raw, { postcodeRepair: true })
		const ct = await cand.parse(row.raw, { postcodeRepair: true })
		const bl = (decodeAsJSON(bt) as Record<string, string>).locality ?? ""
		const cl = (decodeAsJSON(ct) as Record<string, string>).locality ?? ""
		const br = await didResolve(bt)
		const cr = await didResolve(ct)

		if (bl !== cl) diff++

		if (br) baseRes++

		if (cr) candRes++

		if (br && !cr) candLostThatBaseHad++
		const flag = br && !cr ? " <<< base resolved, cand DIDN'T" : ""
		console.log(
			`gold=${(row.components.locality ?? "").padEnd(22)} | v180="${bl}"[${br ? "R" : "-"}]  v190="${cl}"[${cr ? "R" : "-"}]${flag}`
		)
	}
	console.log(
		`\n${cc}: n=${rows.length} | locality differs v180≠v190: ${diff} (${((100 * diff) / rows.length).toFixed(0)}%)`
	)
	console.log(`resolve: v180=${baseRes} v190=${candRes} | rows v180-resolved-but-v190-didn't: ${candLostThatBaseHad}`)
}
await main()
