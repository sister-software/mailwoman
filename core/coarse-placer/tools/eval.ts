/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Evaluate the #244 coarse-placer: in-distribution accuracy + per-class + calibration (ECE) on the
 *   held-out test split, AND the abstention story on the multi-script set — off-map scripts
 *   (Cyrillic, Arabic, Thai, …, none of them in the 11 trained countries) SHOULD draw low
 *   confidence → abstain, which is the "probably off my loaded map" behavior the design wants.
 *
 *   Run: `mailwoman placer eval in-distribution [--model <dir>] [--abstain 0.5]`
 */

import { readFileSync } from "node:fs"
import * as path from "node:path"

import { dataRootPath } from "../../utils/data-root.ts"
import { repoRootPath } from "../../utils/repo.ts"
import { CoarsePlacer, type CoarsePlacerMeta, type CoarsePrediction } from "../coarse-placer.ts"

interface TestRow {
	raw: string
	country: string
}

interface MultiScriptRow {
	raw: string
	country: string
	script: string
}

/** Options for {@linkcode evalCoarsePlacer}. */
export interface EvalCoarsePlacerOptions {
	/** Model artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`. */
	model?: string
	/** Abstention threshold. Default 0.5. */
	abstain?: number
	/** Dataset dir (`test.jsonl`). Default `<repo>/data/coarse-placer`. */
	data?: string
}

/** Result of {@linkcode evalCoarsePlacer}. */
export interface EvalCoarsePlacerResult {
	n: number
	/** Overall accuracy in percent. */
	accuracy: number
	/** 10-bucket expected calibration error. */
	ece: number
}

/** Coarse-placer in-distribution eval — see the module doc. Emits the report to stdout. */
export async function evalCoarsePlacer(options: EvalCoarsePlacerOptions = {}): Promise<EvalCoarsePlacerResult> {
	const modelDir = options.model || dataRootPath("coarse-placer", "model")
	const abstain = options.abstain ?? 0.5
	const dataDir = options.data || repoRootPath("data", "coarse-placer")

	const meta = JSON.parse(readFileSync(path.join(modelDir, "meta.json"), "utf8")) as CoarsePlacerMeta
	const weights = new Float32Array(readFileSync(path.join(modelDir, "weights.bin")).buffer)
	const placer = new CoarsePlacer({ ...meta, weights }, { abstainBelow: abstain })

	// --- In-distribution test: accuracy + per-class + ECE ---
	const test: TestRow[] = readFileSync(path.join(dataDir, "test.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as TestRow)
	let correct = 0
	const perClass: Record<string, { n: number; ok: number }> = {} // country → {n, ok}
	const confusion: Record<string, Record<string, number>> = {} // true → {pred → n}
	const buckets = Array.from({ length: 10 }, () => ({ n: 0, ok: 0 }))

	// ECE deciles
	for (const r of test) {
		const p = placer.predict(r.raw)
		const pred = p.country ?? "(abstain)"
		;(perClass[r.country] ??= { n: 0, ok: 0 }).n++
		;(confusion[r.country] ??= {})[pred] = ((confusion[r.country] ??= {})[pred] ?? 0) + 1
		const hit = pred === r.country

		if (hit) {
			correct++
			perClass[r.country]!.ok++
		}
		const b = Math.min(9, Math.floor(p.confidence * 10))
		buckets[b]!.n++

		if (hit) {
			buckets[b]!.ok++
		}
	}
	console.log(`coarse-placer eval — test n=${test.length}`)
	console.log(`  overall accuracy: ${((100 * correct) / test.length).toFixed(2)}%  (abstain threshold ${abstain})`)
	console.log(`  per-class recall:`)

	for (const c of meta.classes) {
		const s = perClass[c]

		if (s) {
			console.log(`    ${c}: ${((100 * s.ok) / s.n).toFixed(1)}%  (n=${s.n})`)
		}
	}
	let ece = 0
	const N = test.length

	for (let i = 0; i < 10; i++) {
		const bk = buckets[i]!

		if (bk.n === 0) continue
		const acc = bk.ok / bk.n
		const conf = (i + 0.5) / 10
		ece += (bk.n / N) * Math.abs(acc - conf)
	}
	console.log(`  ECE (10-bucket): ${ece.toFixed(4)}`)

	// Top confusions
	const confLines: string[] = []

	for (const t of meta.classes) {
		for (const [pred, n] of Object.entries(confusion[t] ?? {})) {
			if (pred !== t && n >= 20) {
				confLines.push(`    ${t}→${pred}: ${n}`)
			}
		}
	}

	if (confLines.length) {
		console.log(`  notable confusions (≥20):`)
		console.log(confLines.sort().join("\n"))
	}

	// --- Abstention on the multi-script set (off-map scripts should abstain) ---
	const msPath = repoRootPath("data", "eval", "multi-script", "v0.5.0-a0.jsonl")

	try {
		const ms: MultiScriptRow[] = readFileSync(msPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as MultiScriptRow)
		const TRAINED_SCRIPTS = new Set(["latin", "cjk"]) // the only scripts among the 11 trained countries
		// With the OTHER class, an off-map input is HANDLED if it routes to OTHER or abstains — either way
		// it's not a confident mis-placement onto a wrong country.
		const handled = (p: CoarsePrediction): boolean => p.abstained || p.country === "OTHER"
		let offN = 0,
			offOk = 0,
			missN = 0,
			missOk = 0
		const offMiss: string[] = []

		for (const r of ms) {
			const p = placer.predict(r.raw)
			const offMap = !TRAINED_SCRIPTS.has(r.script)

			if (offMap) {
				offN++

				if (handled(p)) {
					offOk++
				} else if (offMiss.length < 8) {
					offMiss.push(
						`    ${r.script}/${r.country} → ${p.country} @${p.confidence.toFixed(2)}  «${r.raw.slice(0, 30)}»`
					)
				}
			} else {
				missN++

				if (handled(p)) {
					missOk++
				} // a latin/cjk in-map input mis-routed to OTHER = a false abstention
			}
		}
		console.log(`\nmulti-script off-map handling (n=${ms.length}):`)
		console.log(
			`  OFF-map scripts (Cyrillic/Arabic/Thai/…) routed to OTHER-or-abstain: ${offOk}/${offN} (${((100 * offOk) / Math.max(1, offN)).toFixed(0)}%) ← want HIGH`
		)
		console.log(
			`  ON-map scripts (latin/cjk) wrongly OTHER-or-abstain: ${missOk}/${missN} (${((100 * missOk) / Math.max(1, missN)).toFixed(0)}%) ← want LOW`
		)

		if (offMiss.length) {
			console.log(`  off-map still mis-placed (the Latin-off-map residual — needs full off-map addresses, M3):`)
			console.log(offMiss.join("\n"))
		}
	} catch (e) {
		console.log(`\n(multi-script set not found at ${msPath}: ${(e as Error).message})`)
	}

	return { n: test.length, accuracy: (100 * correct) / test.length, ece }
}
