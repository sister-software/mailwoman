import { readLocalBuffer, pathExists } from "@mailwoman/core/fs/readers"
import { NeuralAddressClassifier } from "@mailwoman/neural/classifier"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { WebONNXRunner } from "@mailwoman/neural/web-onnx-runner"
import { resolveWeights } from "@mailwoman/neural/weights"
import { readLabelsFromModelCard } from "@mailwoman/neural/weights-channels"
import { describe, expect, test } from "vitest"

async function probeWeights(): Promise<{ modelPath: string; tokenizerPath: string; modelCardPath?: string } | null> {
	try {
		const r = await resolveWeights({})

		if (!(await pathExists(r.modelPath)) || !(await pathExists(r.tokenizerPath))) return null

		return r
	} catch {
		return null
	}
}

const weights = await probeWeights()
const haveWeights = weights !== null

describe.skipIf(!haveWeights)("WebONNXRunner", () => {
	test("loads a real model and produces logits of the expected shape", async () => {
		const modelBytes = new Uint8Array(await readLocalBuffer(weights!.modelPath))
		const runner = await WebONNXRunner.fromBytes(modelBytes, { useWebGPU: false })
		const tokenIDs = [1, 2, 3, 4, 5]
		const result = await runner.infer(tokenIDs)

		expect(result.numLabels).toBeGreaterThan(0)
		expect(result.logits).toHaveLength(tokenIDs.length)
		expect(result.logits[0]?.length).toBe(result.numLabels)

		for (const row of result.logits) {
			for (const v of row) {
				expect(Number.isFinite(v)).toBe(true)
			}
		}
	})

	test("Classifier.parse works with a WebONNXRunner injected", async () => {
		const modelBytes = new Uint8Array(await readLocalBuffer(weights!.modelPath))

		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(weights!.tokenizerPath),
			WebONNXRunner.fromBytes(modelBytes, { useWebGPU: false }),
		])

		const labels = await readLabelsFromModelCard(weights!.modelCardPath)
		const classifier = new NeuralAddressClassifier({ tokenizer, runner, labels })

		const tree = await classifier.parse("123 Main St, Springfield, IL 62704")
		expect(tree.raw).toBe("123 Main St, Springfield, IL 62704")
		expect(tree.roots.length).toBeGreaterThan(0)

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
			for (const c of n.children) {
				stack.push(c as { tag: string; children?: unknown[] })
			}
		}
	}

	return out
}
