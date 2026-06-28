/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Quick comparison of demo presets between two models. Usage: npx tsx
 *   scripts/eval/demo-preset-compare.ts [--model-path output/v052-model.onnx]
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

const modelPath = process.argv.find((a) => a.startsWith("--model-path="))?.split("=")[1]

async function run() {
	const baseline = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	console.log("=== BASELINE (v0.5.1 current weights) ===\n")

	for (const addr of PRESETS) {
		const r = await baseline.parseJson(addr)
		const comps = Object.entries(r)
			.map(([k, v]) => `${k}=${v}`)
			.join(", ")
		console.log(`  ${addr}`)
		console.log(`    → ${comps || "(empty)"}\n`)
	}

	const tokenizerPath = process.argv.find((a) => a.startsWith("--tokenizer-path="))?.split("=")[1]

	if (modelPath) {
		const candidate = await NeuralAddressClassifier.loadFromWeights({ modelPath, tokenizerPath })
		console.log(`\n=== CANDIDATE (${modelPath}) ===\n`)

		for (const addr of PRESETS) {
			const r = await candidate.parseJson(addr)
			const comps = Object.entries(r)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ")
			console.log(`  ${addr}`)
			console.log(`    → ${comps || "(empty)"}\n`)
		}
	}
}

run().catch(console.error)
