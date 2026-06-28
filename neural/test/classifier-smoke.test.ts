/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   End-to-end smoke test for `NeuralAddressClassifier`.
 *
 *   Loads the v0.2.0 int8 model from the host-side weights dir (not committed to the repo because of
 *   size). Skips gracefully when the model isn't present so CI in non-host environments still
 *   passes. To run locally:
 *
 *   - Tokenizer.model is in `packages/neural/neural/test/fixtures/` (committed)
 *   - Model.onnx is read from $MAILWOMAN_TEST_ONNX_MODEL or the default path below
 */

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier } from "../classifier.js"
import { OnnxRunner } from "../onnx-runner.js"
import { MailwomanTokenizer } from "../tokenizer.js"

const here = dirname(fileURLToPath(import.meta.url))
const TOKENIZER_PATH = resolve(here, "fixtures/tokenizer-v0.1.0.model")
const MODEL_PATH =
	process.env.MAILWOMAN_TEST_ONNX_MODEL ??
	"/mnt/playpen/mailwoman-data/models/quantized/model-stage1-coarse-step-050000-int8.onnx"

const haveModel = existsSync(MODEL_PATH)

describe.skipIf(!haveModel)("NeuralAddressClassifier — smoke (v0.2.0 int8)", () => {
	test("parses the white-house address into a non-empty tree", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const runner = await OnnxRunner.create(MODEL_PATH)
		const cls = new NeuralAddressClassifier({ tokenizer, runner })

		const tree = await cls.parse("1600 Pennsylvania Avenue NW, Washington, DC 20500")
		expect(tree.roots.length).toBeGreaterThan(0)
	})

	test("parseXml emits an <address> root with at least one component", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const runner = await OnnxRunner.create(MODEL_PATH)
		const cls = new NeuralAddressClassifier({ tokenizer, runner })

		const xml = await cls.parseXml("75004 Paris")
		expect(xml).toMatch(/^<address /)
		expect(xml).toContain("</address>")
	})

	test("parseJson returns at least one coarse component for a familiar address", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const runner = await OnnxRunner.create(MODEL_PATH)
		const cls = new NeuralAddressClassifier({ tokenizer, runner })

		const json = await cls.parseJson("Washington, DC 20500")
		const coarseHits = ["country", "region", "locality", "postcode"].filter((k) => k in json)
		expect(coarseHits.length).toBeGreaterThan(0)
	})

	test("empty input returns empty tree without error", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const runner = await OnnxRunner.create(MODEL_PATH)
		const cls = new NeuralAddressClassifier({ tokenizer, runner })

		const tree = await cls.parse("")
		expect(tree.roots).toEqual([])
	})
})

if (!haveModel) {
	describe("NeuralAddressClassifier — smoke (skipped)", () => {
		test(`model not at ${MODEL_PATH} — set MAILWOMAN_TEST_ONNX_MODEL to enable`, () => {
			expect(true).toBe(true)
		})
	})
}
