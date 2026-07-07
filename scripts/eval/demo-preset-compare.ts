import { parseArgs } from "node:util"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Quick comparison of demo presets between two models. Usage: npx tsx
 *   scripts/eval/demo-preset-compare.ts [--model-path output/v052-model.onnx]
 */

import { NeuralAddressClassifier } from "@mailwoman/neural"

// Loose scan parity with the retired --flag=value find() scans: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: { "model-path": { type: "string" }, "tokenizer-path": { type: "string" } },
	strict: false,
	allowPositionals: true,
})
const values = rawValues as { "model-path"?: string; "tokenizer-path"?: string }

const PRESETS = [
	"1600 Pennsylvania Ave NW, Washington, DC 20500",
	"350 5th Ave, New York, NY 10118",
	"Pier 39, San Francisco, CA 94133",
	"1060 W Addison St, Chicago, IL 60613",
	"400 Broad St, Seattle, WA 98109",
	"90210",
]

const modelPath = values["model-path"] as string | undefined

async function run() {
	const baseline = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	console.log("=== BASELINE (v0.5.1 current weights) ===\n")

	for (const addr of PRESETS) {
		const r = await baseline.parseJSON(addr)
		const comps = Object.entries(r)
			.map(([k, v]) => `${k}=${v}`)
			.join(", ")
		console.log(`  ${addr}`)
		console.log(`    → ${comps || "(empty)"}\n`)
	}

	const tokenizerPath = values["tokenizer-path"] as string | undefined

	if (modelPath) {
		const candidate = await NeuralAddressClassifier.loadFromWeights({ modelPath, tokenizerPath })
		console.log(`\n=== CANDIDATE (${modelPath}) ===\n`)

		for (const addr of PRESETS) {
			const r = await candidate.parseJSON(addr)
			const comps = Object.entries(r)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ")
			console.log(`  ${addr}`)
			console.log(`    → ${comps || "(empty)"}\n`)
		}
	}
}

run().catch(console.error)
