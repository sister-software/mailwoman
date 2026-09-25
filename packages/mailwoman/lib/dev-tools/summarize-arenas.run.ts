/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Prints per-arena pass rates from result sidecars, with the postal arena also grouped by edge class.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pyFixed } from "@mailwoman/core/numeric"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { JSONSpliterator } from "spliterator"

const { positionals } = parseArguments({ allowPositionals: true })

/**
 * Describes the fields read from one arena result.
 */
interface Result {
	neural_pass: boolean
	neural_tree_valid?: boolean
	input: string
}

function pct(x: number, n: number): string {
	// `pyFixed` rounds like Python so the output matches the earlier Python report.
	return n ? `${pyFixed((100 * x) / n, 0)}%` : "—"
}

async function main(): Promise<void> {
	const [outDir, postalSrc] = [positionals[0]!, positionals[1]!]
	const arenas = ["libpostal", "perturb", "postal"]

	console.log("| arena | n | neural | fail | tree-valid |")
	console.log("| --- | --: | --: | --: | --: |")

	const loaded: Record<string, Result[]> = {}

	for (const a of arenas) {
		let res: Result[]

		try {
			// A missing sidecar is skipped.
			// Any other read error is rethrown.
			res = await readLocalJSONFile<Result[]>(`${outDir}/${a}.results.json`)
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

	// Postal results join to their source cases by input text.
	if ("postal" in loaded) {
		const ec: Record<string, string> = {}

		for await (const row of JSONSpliterator.fromAsync<{ input: string; edge_class?: string }>(postalSrc)) {
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

runIfScript(import.meta, main)
