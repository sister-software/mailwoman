/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Summarize-arenas.ts — per-arena pass-rate table from external-arenas.ts output.
 *
 *   Reads the per-arena `*.results.json` sidecars written by harness-neural. For the
 *   postal-standards arena it also joins back to the source JSONL (on `input`) to break the rates
 *   down by edge_class — the dimension the harness sidecar drops.
 *
 *   Ported faithfully from scripts/eval/summarize-arenas.py (pure JSON, no numpy); the v0 buckets
 *   went with the rules parser (v7 excision #1151 — harness-v0-neural was deleted with it).
 *
 *   Usage: node scripts/eval/summarize-arenas.ts <out-dir>
 *   <postal-cases.jsonl>
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { pyFixed } from "@mailwoman/core/utils"

const { positionals } = parseArgs({ allowPositionals: true, strict: false })

interface Result {
	neural_pass: boolean
	neural_tree_valid?: boolean
	input: string
}

function pct(x: number, n: number): string {
	return n ? `${pyFixed((100 * x) / n, 0)}%` : "—"
}

function main(): void {
	const [outDir, postalSrc] = [positionals[0]!, positionals[1]!]
	const arenas = ["libpostal", "perturb", "postal"]

	console.log("| arena | n | neural | fail | tree-valid |")
	console.log("| --- | --: | --: | --: | --: |")

	const loaded: Record<string, Result[]> = {}

	for (const a of arenas) {
		let res: Result[]

		try {
			res = JSON.parse(readFileSync(`${outDir}/${a}.results.json`, "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				console.log(`| ${a} | (no results) |`)

				continue
			}

			throw error
		}

		loaded[a] = res
		const n = res.length
		const ne = res.filter((r) => r.neural_pass).length
		const treeOk = res.filter((r) => r.neural_tree_valid).length

		console.log(`| ${a} | ${n} | ${pct(ne, n)} | ${pct(n - ne, n)} | ${pct(treeOk, n)} |`)
	}

	// postal edge-class breakdown (join on input)
	if ("postal" in loaded) {
		const ec: Record<string, string> = {}

		for (const line of readFileSync(postalSrc, "utf8").split("\n")) {
			if (!line) continue
			const row = JSON.parse(line)
			ec[row.input] = row.edge_class ?? "?"
		}

		const by: Record<string, Result[]> = {}

		for (const r of loaded.postal!) {
			const cls = ec[r.input] ?? "?"
			;(by[cls] ??= []).push(r)
		}

		console.log("\n### postal arena by edge_class")
		console.log("| edge_class | n | neural | fail |")
		console.log("| --- | --: | --: | --: |")

		for (const cls of Object.keys(by).toSorted()) {
			const res = by[cls]!
			const n = res.length
			const ne = res.filter((r) => r.neural_pass).length

			console.log(`| ${cls} | ${n} | ${pct(ne, n)} | ${pct(n - ne, n)} |`)
		}
	}
}

if (import.meta.main) {
	main()
}
