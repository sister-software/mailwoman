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

import { basename, type PathBuilderLike, resolvePath, resolvePathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { CoarsePlacer, isOffMapHandled } from "#coarse-placer/coarse-placer"
import { defaultDataDir, defaultModelDir } from "#coarse-placer/tools/paths"
import { formatPercent } from "#utils"

/**
 * Samples a bucket needs before its off-map rate is reported rather than folded into the tail.
 */
const MIN_REPORTABLE_SAMPLES = 8

interface OffMapRow {
	raw: string
	country: string
	group: string
	srcCountry: string
}

/**
 * Options for {@linkcode evalLatinOffmap}.
 */
export interface EvalLatinOffmapOptions {
	/**
	 * Model artifact dir. Default `$MAILWOMAN_DATA_ROOT/coarse-placer/model`.
	 */
	model?: PathBuilderLike
	/**
	 * Abstention threshold. Default 0.5.
	 */
	abstain?: number
	/**
	 * Dataset dir (`test-latin-offmap.jsonl`). Default `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
}

/**
 * Result of {@linkcode evalLatinOffmap}.
 */
export interface EvalLatinOffmapResult {
	n: number
	handled: number
}

/**
 * Coarse-placer Latin off-map handling eval — see the module doc. Emits the report to stdout.
 */
export async function evalLatinOffmap(options: EvalLatinOffmapOptions = {}): Promise<EvalLatinOffmapResult> {
	const modelDir = resolvePathBuilder(options.model || defaultModelDir())
	const abstain = options.abstain ?? 0.5
	const dataDir = options.data || defaultDataDir()

	const placer = await CoarsePlacer.fromArtifactDir(resolvePath(modelDir), { abstainBelow: abstain })

	const rows = await Array.fromAsync(
		JSONSpliterator.fromAsync<OffMapRow>(resolvePath(dataDir, "test-latin-offmap.jsonl"))
	)

	const by: Record<string, { n: number; ok: number }> = {} // key → {n, ok}
	const missTo: Record<string, number> = {} // wrong country → count
	const bump = (k: string): { n: number; ok: number } => (by[k] ??= { n: 0, ok: 0 })
	let n = 0
	let ok = 0
	const samples: string[] = []

	for (const r of rows) {
		const p = placer.predict(r.raw)
		const h = isOffMapHandled(p)

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

			if (samples.length < MIN_REPORTABLE_SAMPLES) {
				samples.push(`    ${r.srcCountry} → ${p.country} @${p.confidence.toFixed(2)}  «${r.raw.slice(0, 38)}»`)
			}
		}
	}

	console.log(`Latin off-map handling — model ${basename(modelDir)} (abstain ${abstain}, n=${n})`)
	console.log(`  OVERALL handled (OTHER-or-abstain): ${ok}/${n} (${formatPercent(ok, n)})  ← want ≥90%`)
	console.log(`  by group:`)

	for (const k of Object.keys(by)
		.filter((key) => key.startsWith("group:"))
		.toSorted()) {
		console.log(`    ${k.slice(6).padEnd(8)} ${formatPercent(by[k]!.ok, by[k]!.n)} (n=${by[k]!.n})`)
	}

	console.log(`  by source country:`)

	for (const k of Object.keys(by)
		.filter((key) => key.startsWith("cc:"))
		.toSorted()) {
		console.log(`    ${k.slice(3).padEnd(4)} ${formatPercent(by[k]!.ok, by[k]!.n)} (n=${by[k]!.n})`)
	}

	const misses = Object.entries(missTo).toSorted((a, b) => b[1] - a[1])

	if (misses.length) {
		console.log(`  misses land on: ${misses.map(([c, m]) => `${c}:${m}`).join(", ")}`)
	}

	if (samples.length) {
		console.log(`  sample misplacements:\n${samples.join("\n")}`)
	}

	return { n, handled: ok }
}
