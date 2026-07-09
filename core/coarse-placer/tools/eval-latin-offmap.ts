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
 *   Run: `mailwoman placer eval latin-offmap --model <dir> [--abstain 0.5]`
 */

import { readFileSync } from "node:fs"
import * as path from "node:path"

import { dataRootPath } from "../../utils/data-root.ts"
import { repoRootPath } from "../../utils/repo.ts"
import { formatPercent } from "../../utils/stats.ts"
import { CoarsePlacer, type CoarsePlacerMeta, type CoarsePrediction } from "../coarse-placer.ts"

interface OffMapRow {
	raw: string
	country: string
	group: string
	srcCountry: string
}

/** Options for {@linkcode evalLatinOffmap}. */
export interface EvalLatinOffmapOptions {
	/** Model artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`. */
	model?: string
	/** Abstention threshold. Default 0.5. */
	abstain?: number
	/** Dataset dir (`test-latin-offmap.jsonl`). Default `<repo>/data/coarse-placer`. */
	data?: string
}

/** Result of {@linkcode evalLatinOffmap}. */
export interface EvalLatinOffmapResult {
	n: number
	handled: number
}

/** Coarse-placer Latin off-map handling eval — see the module doc. Emits the report to stdout. */
export async function evalLatinOffmap(options: EvalLatinOffmapOptions = {}): Promise<EvalLatinOffmapResult> {
	const modelDir = options.model || dataRootPath("coarse-placer", "model")
	const abstain = options.abstain ?? 0.5
	const dataDir = options.data || repoRootPath("data", "coarse-placer")

	const meta = JSON.parse(readFileSync(path.join(modelDir, "meta.json"), "utf8")) as CoarsePlacerMeta
	const buf = readFileSync(path.join(modelDir, "weights.bin"))
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
	const placer = new CoarsePlacer({ ...meta, weights }, { abstainBelow: abstain })

	const rows: OffMapRow[] = readFileSync(path.join(dataDir, "test-latin-offmap.jsonl"), "utf8")
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
	console.log(`Latin off-map handling — model ${path.basename(modelDir)} (abstain ${abstain}, n=${n})`)
	console.log(`  OVERALL handled (OTHER-or-abstain): ${ok}/${n} (${formatPercent(ok, n)})  ← want ≥90%`)
	console.log(`  by group:`)

	for (const k of Object.keys(by)
		.filter((k) => k.startsWith("group:"))
		.sort()) {
		console.log(`    ${k.slice(6).padEnd(8)} ${formatPercent(by[k]!.ok, by[k]!.n)} (n=${by[k]!.n})`)
	}
	console.log(`  by source country:`)

	for (const k of Object.keys(by)
		.filter((k) => k.startsWith("cc:"))
		.sort()) {
		console.log(`    ${k.slice(3).padEnd(4)} ${formatPercent(by[k]!.ok, by[k]!.n)} (n=${by[k]!.n})`)
	}
	const misses = Object.entries(missTo).sort((a, b) => b[1] - a[1])

	if (misses.length) {
		console.log(`  misses land on: ${misses.map(([c, m]) => `${c}:${m}`).join(", ")}`)
	}

	if (samples.length) {
		console.log(`  sample misplacements:\n${samples.join("\n")}`)
	}

	return { n, handled: ok }
}
