/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration test for the QueryShape soft-prior path in `NeuralAddressClassifier.parse()`.
 *
 *   Uses a fake `NeuralRunner` so the test runs in milliseconds without a real model file. Pins
 *   specific logit shapes and verifies the queryShape opt nudges the Viterbi decoder's choices.
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { NeuralAddressClassifier, type NeuralRunner } from "../classifier.js"
import { STAGE2_BIO_LABELS } from "../labels.js"
import type { InferResult } from "../onnx-runner.js"
import type { QueryShapeLike } from "../query-shape-prior.js"
import { MailwomanTokenizer } from "../tokenizer.js"

const here = dirname(fileURLToPath(import.meta.url))
const TOKENIZER_PATH = resolve(here, "fixtures/tokenizer-v0.1.0.model")

/** Fake runner that emits a pre-canned logits matrix regardless of input. */
class FakeRunner implements NeuralRunner {
	constructor(private readonly canned: number[][]) {}
	async infer(_ids: number[]): Promise<InferResult> {
		return { logits: this.canned, sequenceLength: this.canned.length }
	}
}

/** Build a uniform-noise logits matrix with a small boost on the named label for the given index. */
function logitsWithBoost(numTokens: number, boostIdx: number, boostLabel: string, boostMagnitude = 0.3): number[][] {
	const numLabels = STAGE2_BIO_LABELS.length
	const labelIdx = STAGE2_BIO_LABELS.indexOf(boostLabel as (typeof STAGE2_BIO_LABELS)[number])
	const matrix: number[][] = []
	for (let t = 0; t < numTokens; t++) {
		const row = new Array<number>(numLabels).fill(0)
		if (t === boostIdx && labelIdx >= 0) row[labelIdx] = boostMagnitude
		matrix.push(row)
	}
	return matrix
}

describe("NeuralAddressClassifier — queryShape integration", () => {
	it("no queryShape → labels driven purely by encoder", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const text = "350 5th Ave 10118"
		const { pieces } = tokenizer.encode(text)
		const numTokens = pieces.length

		// Encoder slightly favors O on every token (small uniform boost).
		const logits: number[][] = []
		const oIdx = STAGE2_BIO_LABELS.indexOf("O")
		for (let t = 0; t < numTokens; t++) {
			const row = new Array<number>(STAGE2_BIO_LABELS.length).fill(0)
			row[oIdx] = 0.5
			logits.push(row)
		}

		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })
		const tree = await classifier.parse(text)

		// With no prior, all-O emissions → no real components emerge.
		expect(tree.roots.every((r) => r.tag !== "postcode")).toBe(true)
	})

	it("queryShape with us_zip hit promotes the matching token to B-postcode", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const text = "350 5th Ave 10118"
		const { pieces } = tokenizer.encode(text)
		const numTokens = pieces.length

		// All-O emissions — encoder has zero signal.
		const oIdx = STAGE2_BIO_LABELS.indexOf("O")
		const logits: number[][] = []
		for (let t = 0; t < numTokens; t++) {
			const row = new Array<number>(STAGE2_BIO_LABELS.length).fill(0)
			row[oIdx] = 0.5
			logits.push(row)
		}

		// QueryShape: a single us_zip hit covering the "10118" substring.
		const zipStart = text.indexOf("10118")
		const zipEnd = zipStart + 5
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: zipStart, end: zipEnd }, confidence: 0.9 }],
		}

		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })
		// biasScale = 2 makes the postcode bias (0.9 × 2 = 1.8) clearly larger than the O boost (0.5).
		const tree = await classifier.parse(text, { queryShape: shape, queryShapeBiasScale: 2 })

		// A postcode root (or postcode child) should now exist.
		const allTags = collectTags(tree.roots)
		expect(allTags).toContain("postcode")
	})

	it("queryShape bias is overridden when encoder is strongly confident in a different label", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const text = "Paris 10118"
		const { pieces } = tokenizer.encode(text)
		const numTokens = pieces.length

		// Encoder is very confident every token is B-locality (5.0 boost — saturates).
		const localityIdx = STAGE2_BIO_LABELS.indexOf("B-locality")
		const logits: number[][] = []
		for (let t = 0; t < numTokens; t++) {
			const row = new Array<number>(STAGE2_BIO_LABELS.length).fill(0)
			row[localityIdx] = 5.0
			logits.push(row)
		}

		// QueryShape says "10118" is a postcode — but with smaller magnitude than the encoder's
		// 5.0 locality boost.
		const zipStart = text.indexOf("10118")
		const zipEnd = zipStart + 5
		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: zipStart, end: zipEnd }, confidence: 0.6 }],
		}

		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })
		const tree = await classifier.parse(text, { queryShape: shape, queryShapeBiasScale: 1.0 })

		// The encoder's confident locality call wins — postcode bias is too small to overcome it.
		const allTags = collectTags(tree.roots)
		expect(allTags).toContain("locality")
	})

	it("confidence reported on tokens is the encoder's raw probability, not bias-augmented", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const text = "10118"
		const { pieces } = tokenizer.encode(text)
		const numTokens = pieces.length

		// Encoder is uncertain (uniform logits).
		const logits: number[][] = []
		for (let t = 0; t < numTokens; t++) {
			logits.push(new Array<number>(STAGE2_BIO_LABELS.length).fill(0))
		}

		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.9 }],
		}

		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })
		const tree = await classifier.parse(text, { queryShape: shape, queryShapeBiasScale: 2 })

		// Even if Viterbi picked B-postcode (thanks to prior), the reported confidence reflects the
		// encoder's actual uncertainty — softmax over uniform logits = 1/numLabels.
		const allNodes = flattenNodes(tree.roots)
		for (const node of allNodes) {
			expect(node.confidence).toBeCloseTo(1 / STAGE2_BIO_LABELS.length, 2)
		}
	})
})

function collectTags(nodes: ReadonlyArray<{ tag: string; children: ReadonlyArray<unknown> }>): string[] {
	const out: string[] = []
	for (const n of nodes) {
		out.push(n.tag)
		out.push(...collectTags(n.children as Parameters<typeof collectTags>[0]))
	}
	return out
}

function flattenNodes(
	nodes: ReadonlyArray<{ tag: string; confidence: number; children: ReadonlyArray<unknown> }>
): Array<{ tag: string; confidence: number }> {
	const out: Array<{ tag: string; confidence: number }> = []
	for (const n of nodes) {
		out.push({ tag: n.tag, confidence: n.confidence })
		out.push(...flattenNodes(n.children as Parameters<typeof flattenNodes>[0]))
	}
	return out
}
