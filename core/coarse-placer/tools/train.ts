/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Train the #244 coarse-placer: a multinomial logistic-regression over the hashed char-n-gram +
 *   script features ({@link featurize}), via plain SGD. CPU-only, a few minutes — no GPU/Modal.
 *   After training, fits a single temperature on val (NLL minimization) for calibrated confidence.
 *   Writes a `meta.json` + `weights.bin` (Float32, row-major [class][feature]) artifact.
 *
 *   Run: `mailwoman placer train [--epochs 12] [--lr 0.1] [--l2 1e-6] [--out
 *   $MAILWOMAN_DATA_ROOT/coarse-placer/model]`
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { dataRootPath } from "../../utils/data-root.ts"
import { repoRootPath } from "../../utils/repo.ts"
import { COARSE_CLASSES, FEATURE_DIM, featurize } from "../featurize.ts"

interface Sample {
	x: Int32Array
	y: number
}

/** Options for {@linkcode trainCoarsePlacer}. */
export interface TrainCoarsePlacerOptions {
	/** SGD epochs. Default 12. */
	epochs?: number
	/** Initial learning rate (decays per epoch). Default 0.1. */
	lr?: number
	/** L2 regularization. Default 1e-6. */
	l2?: number
	/** Artifact output dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`. */
	out?: string
	/** Dataset dir (`{train,val}.jsonl`). Default `<repo>/data/coarse-placer`. */
	data?: string
}

/** Result of {@linkcode trainCoarsePlacer}. */
export interface TrainCoarsePlacerResult {
	outDir: string
	trainRows: number
	valRows: number
	temperature: number
	valNLL: number
}

/** Coarse-placer SGD trainer — see the module doc. */
export async function trainCoarsePlacer(
	options: TrainCoarsePlacerOptions = {},
	report?: (line: string) => void
): Promise<TrainCoarsePlacerResult> {
	const epochs = options.epochs ?? 12
	const lr0 = options.lr ?? 0.1
	const l2 = options.l2 ?? 0.000001
	const outDir = options.out || dataRootPath("coarse-placer", "model")
	const dataDir = options.data || repoRootPath("data", "coarse-placer")

	const C = COARSE_CLASSES.length
	const D = FEATURE_DIM
	const classIdx = new Map<string, number>(COARSE_CLASSES.map((c, i): [string, number] => [c, i]))

	function load(split: string): Sample[] {
		const rows = readFileSync(path.join(dataDir, `${split}.jsonl`), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { raw: string; country: string })
		// Precompute features once: Int32Array of active indices + label id per row.
		const out: Sample[] = []

		for (const r of rows) {
			const y = classIdx.get(r.country)

			if (y === undefined) continue
			out.push({ x: Int32Array.from(featurize(r.raw)), y })
		}

		return out
	}

	report?.("featurizing…")
	const train = load("train")
	const val = load("val")
	report?.(`train ${train.length}  val ${val.length}  classes ${C}  dim ${D}`)

	const W = new Float32Array(C * D)
	const b = new Float32Array(C)

	// Deterministic LCG shuffle (no Math.random → reproducible runs).
	// NOTE(phase4b): deliberately NOT `SeededRandom.shuffle` — that's mulberry32; this LCG stream is
	// what every shipped model was trained on, and swapping the RNG changes the shuffle order (a
	// silent retrain-reproducibility break).
	let rng = 1234567
	const rand = (): number => (rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff
	function shuffle(arr: Sample[]): void {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1))
			;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
		}
	}

	const logits = new Float32Array(C)
	const probs = new Float32Array(C)
	function forward(x: Int32Array): void {
		for (let c = 0; c < C; c++) {
			let s = b[c]!
			const base = c * D

			for (let k = 0; k < x.length; k++) {
				s += W[base + x[k]!]!
			}
			logits[c] = s
		}
		let mx = -Infinity

		for (let c = 0; c < C; c++)
			if (logits[c]! > mx) {
				mx = logits[c]!
			}
		let sum = 0

		for (let c = 0; c < C; c++) {
			const e = Math.exp(logits[c]! - mx)
			probs[c] = e
			sum += e
		}

		for (let c = 0; c < C; c++) {
			probs[c] = probs[c]! / sum
		}
	}

	function accuracy(set: Sample[]): number {
		let ok = 0

		for (const { x, y } of set) {
			forward(x)
			let top = 0

			for (let c = 1; c < C; c++)
				if (probs[c]! > probs[top]!) {
					top = c
				}

			if (top === y) {
				ok++
			}
		}

		return ok / set.length
	}

	for (let ep = 0; ep < epochs; ep++) {
		shuffle(train)
		const lr = lr0 / (1 + 0.5 * ep)

		// simple decay
		for (const { x, y } of train) {
			forward(x)

			for (let c = 0; c < C; c++) {
				const g = probs[c]! - (c === y ? 1 : 0)

				if (g === 0 && c !== y) continue
				b[c] = b[c]! - lr * g
				const base = c * D

				for (let k = 0; k < x.length; k++) {
					const idx = base + x[k]!
					W[idx] = W[idx]! - lr * (g + l2 * W[idx]!)
				}
			}
		}
		report?.(
			`epoch ${ep + 1}/${epochs}  lr=${lr.toFixed(4)}  train_acc=${accuracy(train.slice(0, 5000)).toFixed(4)}  val_acc=${accuracy(val).toFixed(4)}`
		)
	}

	// --- Temperature calibration: minimize val NLL over T by coarse-then-fine 1-D search. ---
	function valNLL(T: number): number {
		let nll = 0

		for (const { x, y } of val) {
			for (let c = 0; c < C; c++) {
				let s = b[c]!
				const base = c * D

				for (let k = 0; k < x.length; k++) {
					s += W[base + x[k]!]!
				}
				logits[c] = s / T
			}
			let mx = -Infinity

			for (let c = 0; c < C; c++)
				if (logits[c]! > mx) {
					mx = logits[c]!
				}
			let sum = 0

			for (let c = 0; c < C; c++) {
				sum += Math.exp(logits[c]! - mx)
			}
			nll += -(logits[y]! - mx - Math.log(sum))
		}

		return nll / val.length
	}
	let bestT = 1
	let bestNLL = Infinity

	for (let T = 0.5; T <= 4.01; T += 0.1) {
		const nll = valNLL(T)

		if (nll < bestNLL) {
			bestNLL = nll
			bestT = T
		}
	}
	report?.(`temperature=${bestT.toFixed(2)}  val_NLL=${bestNLL.toFixed(4)}`)

	mkdirSync(outDir, { recursive: true })
	writeFileSync(
		path.join(outDir, "meta.json"),
		JSON.stringify(
			{
				classes: [...COARSE_CLASSES],
				featureDim: D,
				temperature: bestT,
				bias: [...b],
				trainedAt: null,
				trainRows: train.length,
			},
			null,
			2
		)
	)
	writeFileSync(path.join(outDir, "weights.bin"), Buffer.from(W.buffer))
	report?.(`→ ${outDir}/meta.json + weights.bin (${(W.byteLength / 1e6).toFixed(1)} MB fp32)`)

	return { outDir, trainRows: train.length, valRows: val.length, temperature: bestT, valNLL: bestNLL }
}
