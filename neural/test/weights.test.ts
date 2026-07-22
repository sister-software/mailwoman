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
 *   - The placetype-pair-prior arc Task 5 block is the arc's end-to-end smoke: en-gb resolves
 *       `pairIndexPath`, `loadFromWeights` constructs a country-gated `PairIndexResolver` default, and a
 *       real GB dependent_locality address parses with the tag applied. A companion case proves the
 *       prior is INERT on en-us (no sibling shipped) against the identical GB-shaped input.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier, resolveWeights } from "../index.ts"
import { PairIndexResolver } from "../pair-index-resolver.ts"

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

// The Task 5 smoke's en-gb link-dev-weights run ALSO shells out to `gazetteer pair-index` to build
// pair-index-gb.bin from the PPD tuples CSV (see that script's header) — needs the source CSV on disk
// same as the postcode-binary build needs the WOF shard above.
const PPD_SOURCE_CSV_PATH = dataRootPath("ppd", "2026-07-22", "gb-tuples.csv")
const havePPDSource = existsSync(String(PPD_SOURCE_CSV_PATH))

// Both en-gb tests below shell out to neural-weights-en-gb's link-dev-weights.ts, which (on a COLD
// worktree with no pair-index-gb.bin yet) builds it from the ~25.6M-row PPD tuples CSV — several
// minutes, well past vitest's global 15s default (see that script's header for the skip-if-exists
// fast path this only matters for the FIRST run). Generous per-test timeout, not a perf target.
const LINK_SCRIPT_TIMEOUT_MS = 600_000

/**
 * A real GB address whose middle place ("Fishburn") is the verified PROBE OK (child, parent) pair from the Task-3
 * artifact ("Fishburn" / "Stockton-on-Tees" → dependent_locality). Deliberately house-number-less: with a leading house
 * number ("14 Beulah Hill, …") the base model's own B-locality logit for "Fishburn" is confident enough (raw gap ~6.9)
 * that the +6.0 pair-index delta narrows but does not flip it — this phrasing's unbiased margin is narrow enough for
 * the prior to decide it, which is exactly what an end-to-end smoke should demonstrate.
 */
const GB_DEPENDENT_LOCALITY_ADDRESS = "Beulah Hill, Fishburn, Stockton-on-Tees, TS21 3AB"

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
		},
		LINK_SCRIPT_TIMEOUT_MS
	)
})

// placetype-pair-prior arc, Task 5: the arc's end-to-end proof. `pairIndexPath` resolves on en-gb,
// `loadFromWeights` constructs a country-gated `PairIndexResolver` default from it, and a real GB
// dependent_locality address decodes with the tag applied. The en-us companion proves the SAME input
// produces NO bias when the package ships no sibling index — the prior degrades to byte-stable, not to
// a crash or a silent wrong-country apply.
describe("NeuralAddressClassifier.loadFromWeights — placetype-pair prior (Task 5 smoke)", () => {
	test.skipIf(!haveModel || !haveCLI || !haveGBWofDB || !havePPDSource)(
		"en-gb: pairIndexPath resolves, the country-gated default fires, and Fishburn decodes as dependent_locality",
		async () => {
			const enUSLinkScript = repoRootPath("neural-weights-en-us", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enUSLinkScript], { stdio: "pipe" })

			const enGBLinkScript = repoRootPath("neural-weights-en-gb", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enGBLinkScript], { stdio: "pipe" })

			const r = resolveWeights({ locale: "en-gb" })
			expect(r.pairIndexPath).toMatch(/neural-weights-en-gb\/pair-index-gb\.bin$/)

			// Probe the built artifact directly FIRST (per the brief) — establishes that
			// ("fishburn", "stocktonontees") is genuinely a PROBE OK pair in THIS build before trusting
			// the end-to-end parse below to prove anything about the wiring.
			const resolver = new PairIndexResolver(new Uint8Array(readFileSync(r.pairIndexPath!)))
			expect(resolver.header.country).toBe("gb")
			expect(resolver.probe("fishburn", "stocktonontees")).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const trace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			const placetypePairRecord = trace.priors.find((p) => p.kind === "placetypePair")
			expect(placetypePairRecord?.applied).toBe(true)

			const json = await cls.parseJSON(GB_DEPENDENT_LOCALITY_ADDRESS)
			expect(json.dependent_locality).toBe("Fishburn")
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI)(
		"en-us: no pair-index sibling shipped — the SAME GB-shaped input applies NO placetype-pair bias",
		async () => {
			const enUSLinkScript = repoRootPath("neural-weights-en-us", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enUSLinkScript], { stdio: "pipe" })

			const r = resolveWeights({ locale: "en-us" })
			expect(r.pairIndexPath).toBeUndefined()

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
			const trace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			const placetypePairRecord = trace.priors.find((p) => p.kind === "placetypePair")
			expect(placetypePairRecord?.applied).toBe(false)
		}
	)
})
