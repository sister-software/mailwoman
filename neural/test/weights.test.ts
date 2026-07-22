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
 *   - The en-gb case exercises the #1177 base-overlay dedup: en-gb ships no model.onnx/tokenizer.model
 *       of its own (declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`), so resolution
 *       must fall through to the en-us package dir (`source` suffixed `+base`) while still resolving
 *       en-gb's OWN `postcode-gb.bin` locally.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier, resolveWeights } from "../index.ts"

const TOKENIZER_PATH = repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")
const MODEL_PATH =
	$public.MAILWOMAN_TEST_ONNX_MODEL ??
	String(dataRootPath("models", "quantized", "model-stage1-coarse-step-050000-int8.onnx"))

const haveModel = existsSync(MODEL_PATH)

// The en-gb auto-resolve test's link-dev-weights.ts additionally shells out to the compiled CLI to
// build postcode-gb.bin from the GB WOF postcode shard (see the script's header) — both must be on
// disk for that step to run, or the test would either fail on a missing binary or silently exercise
// an anchor-OFF path it's meant to assert against. Detected the same way `haveModel` is: existsSync
// through the repo's data-root helpers, never a hardcoded path.
const CLI_PATH = repoRootPath("mailwoman", "out", "cli.js")
const GB_WOF_DB_PATH = dataRootPath("wof", "postalcode-gb.db")
const haveCLI = existsSync(CLI_PATH)
const haveGBWofDB = existsSync(String(GB_WOF_DB_PATH))

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
		const linkScript = repoRootPath("neural-weights-en-us", "scripts", "link-dev-weights.ts")
		execFileSync(process.execPath, ["--experimental-strip-types", linkScript], { stdio: "pipe" })

		const r = resolveWeights({ locale: "en-us" })
		expect(r.source).toBe("package:@mailwoman/neural-weights-en-us")
		expect(r.modelPath).toMatch(/neural-weights-en-us\/model\.onnx$/)
		expect(r.tokenizerPath).toMatch(/neural-weights-en-us\/tokenizer\.model$/)
		// v0.4.0: the resolver surfaces model-card.json so loadFromWeights can read
		// the trained label vocabulary from it (issue #116 §5(a)).
		expect(r.modelCardPath).toMatch(/neural-weights-en-us\/model-card\.json$/)
	})

	// #1177 base-overlay dedup, en-gb form: model/tokenizer resolve from the en-us base
	// (mailwoman.baseWeights), while the GB-specific postcode anchor resolves locally.
	//
	// Requires the compiled CLI + the GB WOF postcode shard on top of `haveModel` — link-dev-weights.ts
	// shells out to `mailwoman gazetteer postcode-binary` to build postcode-gb.bin (see the script's
	// header), and that step needs both.
	test.skipIf(!haveModel || !haveCLI || !haveGBWofDB)(
		"en-gb resolves model/tokenizer/model-card from the en-us base + postcode-gb.bin locally, and parses",
		async () => {
			const enUSLinkScript = repoRootPath("neural-weights-en-us", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enUSLinkScript], { stdio: "pipe" })

			const enGBLinkScript = repoRootPath("neural-weights-en-gb", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enGBLinkScript], { stdio: "pipe" })

			const r = resolveWeights({ locale: "en-gb" })
			expect(r.source).toBe("package:@mailwoman/neural-weights-en-gb+base")
			expect(r.modelPath).toMatch(/neural-weights-en-us\/model\.onnx$/)
			expect(r.tokenizerPath).toMatch(/neural-weights-en-us\/tokenizer\.model$/)
			expect(r.anchorLookupPath?.binary).toBe(true)
			expect(r.anchorLookupPath?.path).toMatch(/neural-weights-en-gb\/postcode-gb\.bin$/)
			// Card-less overlay fallback: en-gb ships no model-card.json of its own — it must resolve
			// the en-us base's card so `loadFromWeights` reads the trained (STAGE3+, 33-label) vocab
			// instead of silently defaulting to STAGE2_BIO_LABELS (21 labels), which throws in
			// `assertEmissionWidth` on the first parse (the bug this test guards against).
			expect(r.modelCardPath).toMatch(/neural-weights-en-us\/model-card\.json$/)

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const tree = await cls.parse("10 Downing Street, London SW1A 2AA")
			expect(tree.roots.length).toBeGreaterThan(0)
		}
	)
})
