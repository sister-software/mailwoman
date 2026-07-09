/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Quick comparison of demo presets between two models (`mailwoman eval preset-compare`). Baseline
 *   = the shipped dev weights; pass `modelPath` to also print a candidate's parses. The promotion
 *   gate captures this report into `<out-dir>/presets.md` via the `report` sink.
 */

import { NeuralAddressClassifier } from "@mailwoman/neural"

const PRESETS = [
	"1600 Pennsylvania Ave NW, Washington, DC 20500",
	"350 5th Ave, New York, NY 10118",
	"Pier 39, San Francisco, CA 94133",
	"1060 W Addison St, Chicago, IL 60613",
	"400 Broad St, Seattle, WA 98109",
	"90210",
]

/** Options for {@linkcode presetCompare}. */
export interface PresetCompareOptions {
	/** Candidate ONNX model path. Omit to print the baseline only. */
	modelPath?: string
	/** Candidate tokenizer path (paired with `modelPath`). */
	tokenizerPath?: string
}

/** Run the 6 demo presets through the baseline (and optionally a candidate) and report each parse. */
export async function presetCompare(
	options: PresetCompareOptions,
	report: (line: string) => void = console.log
): Promise<void> {
	const baseline = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	report("=== BASELINE (v0.5.1 current weights) ===\n")

	for (const addr of PRESETS) {
		const r = await baseline.parseJSON(addr)
		const comps = Object.entries(r)
			.map(([k, v]) => `${k}=${v}`)
			.join(", ")
		report(`  ${addr}`)
		report(`    → ${comps || "(empty)"}\n`)
	}

	const { modelPath, tokenizerPath } = options

	if (modelPath) {
		const candidate = await NeuralAddressClassifier.loadFromWeights({ modelPath, tokenizerPath })
		report(`\n=== CANDIDATE (${modelPath}) ===\n`)

		for (const addr of PRESETS) {
			const r = await candidate.parseJSON(addr)
			const comps = Object.entries(r)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ")
			report(`  ${addr}`)
			report(`    → ${comps || "(empty)"}\n`)
		}
	}
}
