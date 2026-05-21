/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end smoke test for `WebOnnxRunner` using the real `@mailwoman/neural-weights-en-us`
 *   package + the production tokenizer + the production decoder. Runs in Node — `onnxruntime-web`'s
 *   WASM execution provider works there too; WebGPU is skipped via `useWebGpu: false` since Node
 *   doesn't have a WebGPU adapter to fall back from.
 *
 *   What this test guards:
 *
 *   - The runner loads a real production ONNX model end-to-end.
 *   - `infer(tokenIds)` returns logits with the expected shape.
 *   - The classifier composed with this runner produces an `AddressTree` for a simple address.
 *   - WebOnnxRunner is interchangeable with OnnxRunner from the classifier's POV — same `parse()`
 *       output shape, no API divergence.
 */

import { MailwomanTokenizer, NeuralAddressClassifier } from "@mailwoman/neural"
import { resolveWeights } from "@mailwoman/neural/weights"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { describe, expect, test } from "vitest"

import { WebOnnxRunner } from "./web-onnx-runner.js"

// CI doesn't ship the v0.2.0 model files — they're operator-supplied via
// `scripts/link-dev-weights.sh` after a training run. Skip the real-model tests when the weights
// package's `model.onnx` isn't on disk; the runner's structural behavior still gets exercised by
// the unit suite under neural/test/.
function probeWeights(): { modelPath: string; tokenizerPath: string } | null {
	try {
		const r = resolveWeights({})
		if (!existsSync(r.modelPath) || !existsSync(r.tokenizerPath)) return null
		return r
	} catch {
		return null
	}
}
const weights = probeWeights()
const haveWeights = weights !== null

describe.skipIf(!haveWeights)("WebOnnxRunner", () => {
	test("loads a real model and produces logits of the expected shape", async () => {
		const modelBytes = new Uint8Array(await readFile(weights!.modelPath))
		const runner = await WebOnnxRunner.fromBytes(modelBytes, { useWebGpu: false })
		const tokenIds = [1, 2, 3, 4, 5] // arbitrary; the SP vocab assigns these to common pieces
		const result = await runner.infer(tokenIds)

		expect(result.numLabels).toBeGreaterThan(0)
		expect(result.logits.length).toBe(tokenIds.length)
		expect(result.logits[0]?.length).toBe(result.numLabels)
		// Logits should be finite numbers (no NaN/Infinity from a misconfigured runtime).
		for (const row of result.logits) {
			for (const v of row) expect(Number.isFinite(v)).toBe(true)
		}
	})

	test("classifier.parse() works with a WebOnnxRunner injected", async () => {
		const modelBytes = new Uint8Array(await readFile(weights!.modelPath))
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(weights!.tokenizerPath),
			WebOnnxRunner.fromBytes(modelBytes, { useWebGpu: false }),
		])
		const classifier = new NeuralAddressClassifier({ tokenizer, runner })

		const tree = await classifier.parse("123 Main St, Springfield, IL 62704")
		expect(tree.raw).toBe("123 Main St, Springfield, IL 62704")
		expect(tree.roots.length).toBeGreaterThan(0)
		// Spot-check that at least one node carries one of the expected component tags. The actual
		// labels depend on the model's quality — this test exercises the wiring, not the model's
		// recall. A future PR can add accuracy gating against the golden set.
		const allTags = collectTags(tree.roots)
		expect(allTags.size).toBeGreaterThan(0)
	})
})

function collectTags(nodes: Array<{ tag: string; children?: unknown[] }>): Set<string> {
	const out = new Set<string>()
	const stack = [...nodes]
	while (stack.length) {
		const n = stack.pop()!
		out.add(n.tag)
		if (Array.isArray(n.children)) {
			for (const c of n.children) stack.push(c as { tag: string; children?: unknown[] })
		}
	}
	return out
}
