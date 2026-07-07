/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit + smoke tests for `NeuralProposalClassifier`.
 *
 *   The unit tests stub a `NeuralAddressClassifier` with a hand-authored `AddressTree` so we exercise
 *   the adapter logic without loading a real model. The smoke test runs against the v0.2.0 int8
 *   weights when `MAILWOMAN_TEST_ONNX_MODEL` (or the default host path) is present.
 */

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { AddressTree } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import type { Section } from "@mailwoman/core/types"
import { dataRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier } from "../classifier.js"
import { createNeuralProposalClassifier } from "../proposal-classifier.js"

/** Minimal duck-typed Section — see proposal-classifier.ts for why we don't construct real Spans. */
function makeSection(body: string, start = 0): Section {
	return { body, start, end: start + body.length } as unknown as Section
}

const here = dirname(fileURLToPath(import.meta.url))
const TOKENIZER_PATH = resolve(here, "fixtures/tokenizer-v0.1.0.model")
const MODEL_PATH =
	$public.MAILWOMAN_TEST_ONNX_MODEL ??
	String(dataRootPath("models", "quantized", "model-stage1-coarse-step-050000-int8.onnx"))
const haveModel = existsSync(MODEL_PATH)

/** Minimal stub that just returns a canned tree, ignoring the input text. */
function stubClassifier(tree: AddressTree): NeuralAddressClassifier {
	return { parse: async () => tree } as unknown as NeuralAddressClassifier
}

describe("createNeuralProposalClassifier — adapter shape", () => {
	test("exposes id + emits + locales from config", () => {
		const cls = createNeuralProposalClassifier({
			id: "neural-v0.2.0-en-us",
			classifier: stubClassifier({ raw: "", roots: [] }),
			locales: ["en-us"],
		})
		expect(cls.id).toBe("neural-v0.2.0-en-us")
		expect(cls.locales).toEqual(["en-us"])
		expect(cls.emits).toContain("locality")
	})

	test("defaults locales to ['*']", () => {
		const cls = createNeuralProposalClassifier({
			id: "x",
			classifier: stubClassifier({ raw: "", roots: [] }),
		})
		expect(cls.locales).toEqual(["*"])
	})
})

describe("createNeuralProposalClassifier — proposal emission", () => {
	const tree: AddressTree = {
		raw: "Paris 75004",
		roots: [
			{
				tag: "locality",
				value: "Paris",
				start: 0,
				end: 5,
				confidence: 0.97,
				children: [{ tag: "postcode", value: "75004", start: 6, end: 11, confidence: 0.99, children: [] }],
			},
		],
	}

	test("emits one proposal per node (root + children, recursive)", async () => {
		const cls = createNeuralProposalClassifier({
			id: "neural-test",
			classifier: stubClassifier(tree),
		})
		const proposals = await cls.classify(makeSection("Paris 75004"), {})
		expect(proposals).toHaveLength(2)
		expect(proposals.map((p) => p.component).sort()).toEqual(["locality", "postcode"])
	})

	test("tags every proposal with source='neural' + the configured source_id", async () => {
		const cls = createNeuralProposalClassifier({
			id: "neural-v0.2.0-en-us",
			classifier: stubClassifier(tree),
		})
		const proposals = await cls.classify(makeSection("Paris 75004"), {})

		for (const p of proposals) {
			expect(p.source).toBe("neural")
			expect(p.source_id).toBe("neural-v0.2.0-en-us")
		}
	})

	test("passes through per-node confidence", async () => {
		const cls = createNeuralProposalClassifier({ id: "n", classifier: stubClassifier(tree) })
		const proposals = await cls.classify(makeSection("Paris 75004"), {})
		const locality = proposals.find((p) => p.component === "locality")!
		const postcode = proposals.find((p) => p.component === "postcode")!
		expect(locality.confidence).toBeCloseTo(0.97, 5)
		expect(postcode.confidence).toBeCloseTo(0.99, 5)
	})

	test("rebases span start to section offset", async () => {
		const cls = createNeuralProposalClassifier({ id: "n", classifier: stubClassifier(tree) })
		// Section starts at char 13 in the (imaginary) full input.
		const section = makeSection("Paris 75004", 13)
		const proposals = await cls.classify(section, {})
		const locality = proposals.find((p) => p.component === "locality")!
		expect(locality.span.start).toBe(13) // section.start (13) + node.start (0)
		const postcode = proposals.find((p) => p.component === "postcode")!
		expect(postcode.span.start).toBe(19) // section.start (13) + node.start (6)
	})

	test("drops nodes whose tag isn't in emits", async () => {
		const cls = createNeuralProposalClassifier({
			id: "n",
			classifier: stubClassifier(tree),
			emits: ["locality"], // postcode excluded
		})
		const proposals = await cls.classify(makeSection("Paris 75004"), {})
		expect(proposals).toHaveLength(1)
		expect(proposals[0]!.component).toBe("locality")
	})

	test("applies the configured penalty to every proposal", async () => {
		const cls = createNeuralProposalClassifier({
			id: "n",
			classifier: stubClassifier(tree),
			penalty: 0.25,
		})
		const proposals = await cls.classify(makeSection("Paris 75004"), {})

		for (const p of proposals) {
			expect(p.penalty).toBe(0.25)
		}
	})
})

describe.skipIf(!haveModel)("createNeuralProposalClassifier — e2e with v0.2.0 weights", () => {
	test("emits at least one coarse proposal for a familiar address", async () => {
		const neural = await NeuralAddressClassifier.loadFromWeights({
			modelPath: MODEL_PATH,
			tokenizerPath: TOKENIZER_PATH,
		})
		const cls = createNeuralProposalClassifier({ id: "neural-v0.2.0-en-us", classifier: neural })
		const proposals = await cls.classify(makeSection("Washington DC 20500"), {})
		const tags = new Set(proposals.map((p) => p.component))
		// Don't over-assert — the v0.2.0 model can miss country/region; insist on at least one of them.
		const coarseHit = ["region", "locality", "postcode"].some((t) => tags.has(t as never))
		expect(coarseHit).toBe(true)

		for (const p of proposals) {
			expect(p.source).toBe("neural")
			expect(p.source_id).toBe("neural-v0.2.0-en-us")
		}
	})
})
