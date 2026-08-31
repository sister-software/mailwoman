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

import { type PathBuilderLike, resolvePath, resolvePathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { CoarsePlacer, type CoarsePlacerMeta, isOffMapHandled } from "#coarse-placer/coarse-placer"
import { defaultDataDir, defaultModelDir } from "#coarse-placer/tools/paths"
import { errorMessage } from "#errors/schema"
import { readLocalJSONFile } from "#fs/readers"
import { formatPercent, repoRootPath } from "#utils"

/**
 * Confusions below this count are individually uninteresting and are summarised instead.
 */
const MIN_CONFUSION_COUNT = 20

/**
 * Off-map misses printed before the list is truncated.
 */
const MAX_LISTED_MISSES = 8

interface TestRow {
	raw: string
	country: string
}

interface MultiScriptRow {
	raw: string
	country: string
	script: string
}

/**
 * Options for {@linkcode evalCoarsePlacer}.
 */
export interface EvalCoarsePlacerOptions {
	/**
	 * Model artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`.
	 */
	model?: PathBuilderLike
	/**
	 * Abstention threshold. Default 0.5.
	 */
	abstain?: number
	/**
	 * Dataset dir (`test.jsonl`). Default `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
}

/**
 * Result of {@linkcode evalCoarsePlacer}.
 */
export interface EvalCoarsePlacerResult {
	n: number
	/**
	 * Overall accuracy in percent.
	 */
	accuracy: number
	/**
	 * 10-bucket expected calibration error.
	 */
	ece: number
}

/**
 * Coarse-placer in-distribution eval — see the module doc. Emits the report to stdout.
 */
export async function evalCoarsePlacer(options: EvalCoarsePlacerOptions = {}): Promise<EvalCoarsePlacerResult> {
	const modelDir = resolvePathBuilder(options.model || defaultModelDir())
	const abstain = options.abstain ?? 0.5
	const dataDir = options.data || defaultDataDir()

	const meta = await readLocalJSONFile<CoarsePlacerMeta>(resolvePath(modelDir, "meta.json"))
	const placer = await CoarsePlacer.fromArtifactDir(resolvePath(modelDir), { abstainBelow: abstain })

	// --- In-distribution test: accuracy + per-class + ECE ---
	let testN = 0
	let correct = 0
	const perClass: Record<string, { n: number; ok: number }> = {} // country → {n, ok}
	const confusion: Record<string, Record<string, number>> = {} // true → {pred → n}
	const buckets = Array.from({ length: 10 }, () => ({ n: 0, ok: 0 }))

	// ECE deciles. The split streams: every figure below is an accumulator, so the rows never all need to be resident.
	for await (const r of JSONSpliterator.fromAsync<TestRow>(resolvePath(dataDir, "test.jsonl"))) {
		testN++

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

	console.log(`coarse-placer eval — test n=${testN}`)
	console.log(`  overall accuracy: ${((100 * correct) / testN).toFixed(2)}%  (abstain threshold ${abstain})`)
	console.log(`  per-class recall:`)

	for (const c of meta.classes) {
		const s = perClass[c]

		if (s) {
			console.log(`    ${c}: ${((100 * s.ok) / s.n).toFixed(1)}%  (n=${s.n})`)
		}
	}

	let ece = 0
	const N = testN

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
			if (pred !== t && n >= MIN_CONFUSION_COUNT) {
				confLines.push(`    ${t}→${pred}: ${n}`)
			}
		}
	}

	if (confLines.length) {
		console.log(`  notable confusions (≥20):`)
		console.log(confLines.toSorted().join("\n"))
	}

	// --- Abstention on the multi-script set (off-map scripts should abstain) ---
	const msPath = repoRootPath("data", "eval", "multi-script", "v0.5.0-a0.jsonl")

	try {
		const TRAINED_SCRIPTS = new Set(["latin", "cjk"]) // the only scripts among the 11 trained countries

		let msN = 0
		let offN = 0
		let offOk = 0
		let missN = 0
		let missOk = 0

		const offMiss: string[] = []

		for await (const r of JSONSpliterator.fromAsync<MultiScriptRow>(msPath)) {
			msN++

			const p = placer.predict(r.raw)
			const offMap = !TRAINED_SCRIPTS.has(r.script)

			if (offMap) {
				offN++

				if (isOffMapHandled(p)) {
					offOk++
				} else if (offMiss.length < MAX_LISTED_MISSES) {
					offMiss.push(
						`    ${r.script}/${r.country} → ${p.country} @${p.confidence.toFixed(2)}  «${r.raw.slice(0, 30)}»`
					)
				}
			} else {
				missN++

				if (isOffMapHandled(p)) {
					missOk++
				} // a latin/cjk in-map input mis-routed to OTHER = a false abstention
			}
		}

		console.log(`\nmulti-script off-map handling (n=${msN}):`)
		console.log(
			`  OFF-map scripts (Cyrillic/Arabic/Thai/…) routed to OTHER-or-abstain: ${offOk}/${offN} (${formatPercent(offOk, offN, 0, { zero: "clamp" })}) ← want HIGH`
		)
		console.log(
			`  ON-map scripts (latin/cjk) wrongly OTHER-or-abstain: ${missOk}/${missN} (${formatPercent(missOk, missN, 0, { zero: "clamp" })}) ← want LOW`
		)

		if (offMiss.length) {
			console.log(`  off-map still mis-placed (the Latin-off-map residual — needs full off-map addresses, M3):`)
			console.log(offMiss.join("\n"))
		}
	} catch (error) {
		console.log(`\n(multi-script set not found at ${msPath}: ${errorMessage(error)})`)
	}

	return { n: testN, accuracy: (100 * correct) / testN, ece }
}
