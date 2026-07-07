/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Summarize-arenas.ts — three-bucket capability table from external-arenas.ts output.
 *
 *   Reads the per-arena `*.results.json` sidecars written by harness-v0-neural and prints the
 *   neural-only / both-pass / v0-only / both-fail buckets per arena. For the postal-standards arena
 *   it also joins back to the source JSONL (on `input`) to break the buckets down by edge_class —
 *   the dimension the harness sidecar drops.
 *
 *   Ported faithfully from scripts/eval/summarize-arenas.py (pure JSON, no numpy).
 *
 *   Usage: node --experimental-strip-types scripts/eval/summarize-arenas.ts <out-dir>
 *   <postal-cases.jsonl>
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

const { positionals } = parseArgs({ allowPositionals: true, strict: false })
interface Result {
	v0_pass: boolean
	neural_pass: boolean
	neural_tree_valid?: boolean
	input: string
}

function buckets(results: Result[]): [number, number, number, number, number, number] {
	const n = results.length
	const both = results.filter((r) => r.v0_pass && r.neural_pass).length
	const onlyN = results.filter((r) => !r.v0_pass && r.neural_pass).length
	const onlyV0 = results.filter((r) => r.v0_pass && !r.neural_pass).length
	const neither = results.filter((r) => !r.v0_pass && !r.neural_pass).length
	const treeOk = results.filter((r) => r.neural_tree_valid).length

	return [n, both, onlyN, onlyV0, neither, treeOk]
}

/** Python `format(x, ".{d}f")` — round-half-to-even (banker's), unlike JS `toFixed` (half-away). */
function pyFixed(x: number, d: number): string {
	if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf"
	const neg = x < 0 || Object.is(x, -0)
	const [intPart, fracRaw = ""] = Math.abs(x).toFixed(20).split(".")
	const frac = fracRaw

	if (frac.length <= d) {
		const body = d > 0 ? `${intPart}.${frac.padEnd(d, "0")}` : intPart!

		return (neg ? "-" : "") + body
	}
	const keep = frac.slice(0, d)
	const rest = frac.slice(d)
	let roundUp: boolean

	if (rest[0]! > "5") {
		roundUp = true
	} else if (rest[0]! < "5") {
		roundUp = false
	} else if (rest.slice(1).replace(/0+$/, "").length > 0) {
		roundUp = true
	} else {
		const lastKept = d > 0 ? (keep[d - 1] ?? "0") : (intPart![intPart!.length - 1] ?? "0")
		roundUp = parseInt(lastKept, 10) % 2 === 1
	}
	let digits = intPart! + keep

	if (roundUp) {
		const arr = digits.split("")
		let i = arr.length - 1

		for (; i >= 0; i--) {
			if (arr[i] === "9") {
				arr[i] = "0"
			} else {
				arr[i] = String(parseInt(arr[i]!, 10) + 1)
				break
			}
		}

		if (i < 0) {
			arr.unshift("1")
		}
		digits = arr.join("")
	}
	const di = digits.length - d
	const body = d > 0 ? `${digits.slice(0, di) || "0"}.${digits.slice(di)}` : digits.slice(0, di) || "0"

	return (neg ? "-" : "") + body
}

function pct(x: number, n: number): string {
	return n ? `${pyFixed((100 * x) / n, 0)}%` : "—"
}

function main(): void {
	const [outDir, postalSrc] = [positionals[0]!, positionals[1]!]
	const arenas = ["libpostal", "perturb", "postal"]

	console.log("| arena | n | v0 | neural | both | neural-only | v0-only | both-fail | tree-valid |")
	console.log("| --- | --: | --: | --: | --: | --: | --: | --: | --: |")
	const loaded: Record<string, Result[]> = {}

	for (const a of arenas) {
		let res: Result[]

		try {
			res = JSON.parse(readFileSync(`${outDir}/${a}.results.json`, "utf-8"))
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				console.log(`| ${a} | (no results) |`)
				continue
			}
			throw e
		}
		loaded[a] = res
		const [n, both, onlyN, onlyV0, neither, treeOk] = buckets(res)
		const v0 = res.filter((r) => r.v0_pass).length
		const ne = res.filter((r) => r.neural_pass).length
		console.log(
			`| ${a} | ${n} | ${pct(v0, n)} | ${pct(ne, n)} | ${pct(both, n)} ` +
				`| ${pct(onlyN, n)} | ${pct(onlyV0, n)} | ${pct(neither, n)} | ${pct(treeOk, n)} |`
		)
	}

	// postal edge-class breakdown (join on input)
	if ("postal" in loaded) {
		const ec: Record<string, string> = {}

		for (const line of readFileSync(postalSrc, "utf-8").split("\n")) {
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
		console.log("| edge_class | n | v0 | neural | both | neural-only | v0-only |")
		console.log("| --- | --: | --: | --: | --: | --: | --: |")

		for (const cls of Object.keys(by).sort()) {
			const res = by[cls]!
			const [n, both, onlyN, onlyV0] = buckets(res)
			const v0 = res.filter((r) => r.v0_pass).length
			const ne = res.filter((r) => r.neural_pass).length
			console.log(
				`| ${cls} | ${n} | ${pct(v0, n)} | ${pct(ne, n)} | ${pct(both, n)} ` +
					`| ${pct(onlyN, n)} | ${pct(onlyV0, n)} |`
			)
		}
	}
}

if (import.meta.main) {
	main()
}
