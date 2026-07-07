import { readFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measure the #244 coarse-placer's handling of the Latin-script off-map residual (milestone 3). A
 *   Latin off-map address is HANDLED when the model routes it to OTHER or abstains — anything else
 *   is a confident mis-placement onto a wrong (trained) country. Reports handled-rate overall, by
 *   group (indist = held-out rows of trained-OTHER countries; heldout = countries never trained),
 *   and by source country, plus where the misses land. Run baseline (current model) and the M3
 *   retrain through this to read the before/after.
 *
 *   Usage: node core/coarse-placer/tools/eval-latin-offmap.ts --model <dir> [--abstain 0.5]
 */
import { dataRootPath } from "@mailwoman/core/utils"

import type { CoarsePlacerMeta, CoarsePrediction } from "../coarse-placer.js"

interface OffMapRow {
	raw: string
	country: string
	group: string
	srcCountry: string
}

const root = new URL("../../", import.meta.url)
const { CoarsePlacer } = (await import(
	new URL("core/out/coarse-placer/coarse-placer.js", root).href
)) as typeof import("../coarse-placer.js")

const { values: args } = parseArgs({
	options: {
		model: { type: "string", default: dataRootPath("coarse-placer", "model") },
		abstain: { type: "string", default: "0.5" },
		data: { type: "string", default: path.resolve(import.meta.dirname, "../../data/coarse-placer") },
	},
})

const meta = JSON.parse(readFileSync(path.join(args.model, "meta.json"), "utf8")) as CoarsePlacerMeta
const buf = readFileSync(path.join(args.model, "weights.bin"))
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
let weights: Float32Array

if (meta.quantization === "int8-per-row") {
	const int8 = new Int8Array(ab)
	const C = meta.classes.length
	const dim = meta.featureDim
	const scales = meta.scales!
	weights = new Float32Array(C * dim)

	for (let c = 0; c < C; c++) {
		const s = scales[c]!
		const base = c * dim

		for (let i = 0; i < dim; i++) {
			weights[base + i] = int8[base + i]! * s
		}
	}
} else {
	weights = new Float32Array(ab)
}
const placer = new CoarsePlacer({ ...meta, weights }, { abstainBelow: Number(args.abstain) })

const rows: OffMapRow[] = readFileSync(path.join(args.data, "test-latin-offmap.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as OffMapRow)

const handled = (p: CoarsePrediction): boolean => p.abstained || p.country === "OTHER"
const by: Record<string, { n: number; ok: number }> = {} // key → {n, ok}
const missTo: Record<string, number> = {} // wrong country → count
const bump = (k: string): { n: number; ok: number } => (by[k] ??= { n: 0, ok: 0 })
let n = 0
let ok = 0
const samples: string[] = []

for (const r of rows) {
	const p = placer.predict(r.raw)
	const h = handled(p)
	n++

	if (h) {
		ok++
	}
	bump(`group:${r.group}`).n++
	bump(`cc:${r.srcCountry}`).n++

	if (h) {
		bump(`group:${r.group}`).ok++
		bump(`cc:${r.srcCountry}`).ok++
	} else {
		missTo[p.country!] = (missTo[p.country!] ?? 0) + 1

		if (samples.length < 8) {
			samples.push(`    ${r.srcCountry} → ${p.country} @${p.confidence.toFixed(2)}  «${r.raw.slice(0, 38)}»`)
		}
	}
}
const pct = (o: number, m: number): string => `${((100 * o) / m).toFixed(1)}%`
console.log(`Latin off-map handling — model ${path.basename(args.model)} (abstain ${args.abstain}, n=${n})`)
console.log(`  OVERALL handled (OTHER-or-abstain): ${ok}/${n} (${pct(ok, n)})  ← want ≥90%`)
console.log(`  by group:`)

for (const k of Object.keys(by)
	.filter((k) => k.startsWith("group:"))
	.sort()) {
	console.log(`    ${k.slice(6).padEnd(8)} ${pct(by[k]!.ok, by[k]!.n)} (n=${by[k]!.n})`)
}
console.log(`  by source country:`)

for (const k of Object.keys(by)
	.filter((k) => k.startsWith("cc:"))
	.sort()) {
	console.log(`    ${k.slice(3).padEnd(4)} ${pct(by[k]!.ok, by[k]!.n)} (n=${by[k]!.n})`)
}
const misses = Object.entries(missTo).sort((a, b) => b[1] - a[1])

if (misses.length) {
	console.log(`  misses land on: ${misses.map(([c, m]) => `${c}:${m}`).join(", ")}`)
}

if (samples.length) {
	console.log(`  sample misplacements:\n${samples.join("\n")}`)
}
