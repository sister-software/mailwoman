/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Weight-resolution + `loadFromWeights` end-to-end tests.
 *
 *   - Explicit-path tests run unconditionally (use the committed dev tokenizer fixture; require the
 *       host-side ONNX model path).
 *   - Auto-resolve tests symlink the dev weights into `@mailwoman/neural-weights-en-us` first and then
 *       attempt `loadFromWeights({locale: "en-us"})`. They skip if the dev model isn't on disk so
 *       CI in stripped-down environments still passes.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPathBuilder } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier, resolveWeights } from "../index.js"

const TOKENIZER_PATH = String(repoRootPathBuilder("neural", "test", "fixtures", "tokenizer-v0.1.0.model"))
const MODEL_PATH =
	$public.MAILWOMAN_TEST_ONNX_MODEL ??
	String(dataRootPath("models", "quantized", "model-stage1-coarse-step-050000-int8.onnx"))

const haveModel = existsSync(MODEL_PATH)

describe("resolveWeights — explicit-path mode", () => {
	test.skipIf(!haveModel)("returns the explicit paths verbatim when both are valid", () => {
		const r = resolveWeights({ modelPath: MODEL_PATH, tokenizerPath: TOKENIZER_PATH })
		expect(r.modelPath).toBe(MODEL_PATH)
		expect(r.tokenizerPath).toBe(TOKENIZER_PATH)
		expect(r.source).toBe("explicit")
	})

	test("throws actionably when explicit modelPath is missing", () => {
		expect(() => resolveWeights({ modelPath: "/no/such/model.onnx", tokenizerPath: TOKENIZER_PATH })).toThrow(
			/Explicit modelPath does not exist/
		)
	})
})

describe("NeuralAddressClassifier.loadFromWeights — explicit-path mode", () => {
	test.skipIf(!haveModel)("loads + parses a known address into a non-empty tree", async () => {
		const cls = await NeuralAddressClassifier.loadFromWeights({
			modelPath: MODEL_PATH,
			tokenizerPath: TOKENIZER_PATH,
		})
		const tree = await cls.parse("75004 Paris")
		expect(tree.roots.length).toBeGreaterThan(0)
	})
})

describe("resolveWeights — package auto-resolve", () => {
	test.skipIf(!haveModel)("finds model.onnx + tokenizer.model after running link-dev-weights.ts", () => {
		const linkScript = String(repoRootPathBuilder("neural-weights-en-us", "scripts", "link-dev-weights.ts"))
		execFileSync(process.execPath, ["--experimental-strip-types", linkScript], { stdio: "pipe" })

		const r = resolveWeights({ locale: "en-us" })
		expect(r.source).toBe("package:@mailwoman/neural-weights-en-us")
		expect(r.modelPath).toMatch(/neural-weights-en-us\/model\.onnx$/)
		expect(r.tokenizerPath).toMatch(/neural-weights-en-us\/tokenizer\.model$/)
		// v0.4.0: the resolver surfaces model-card.json so loadFromWeights can read
		// the trained label vocabulary from it (issue #116 §5(a)).
		expect(r.modelCardPath).toMatch(/neural-weights-en-us\/model-card\.json$/)
	})
})
