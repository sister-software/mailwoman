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
 *   - Task-5 REVIEW FOLLOW-UP (this file's "placetype-pair prior" describe block): the block used to
 *       assert a single argmax flip on `GB_DEPENDENT_LOCALITY_ADDRESS`, whose measured margin at the
 *       shipped δ=6.0 is only ~0.211 logits — any future recalibration of that delta could flip the
 *       assertion for reasons having nothing to do with wiring correctness. Split into three tiers: (a)
 *       WIRING assertions (pairIndexPath resolves; `applied` true/false) stay on the original address and
 *       are margin-independent by construction — `applied` reports whether the prior fired, not whether it
 *       won; (b) a bias-DELTA assertion compares the biased trace against a same-input trace with the
 *       prior forced off (a no-match `PairIndexLike` stub passed via `opts.placetypePair`), so the measured
 *       delta at the child token isolates the prior's own contribution — margin-independent, and provable
 *       without ever touching the model's own unbiased preference; (c) exactly one flip assertion remains,
 *       moved to `GB_WIDE_MARGIN_ADDRESS` — a real census pair chosen by probing candidates from
 *       `scratchpad/gb-probe-grade/census-gb-pairs.jsonl` for the widest post-bias margin (see that
 *       const's docstring for the measured candidate table). Margin ≥~3 survives a δ recalibration down to
 *       ~3 before the flip could invert.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier, resolveWeights } from "../index.ts"
import { PairIndexResolver, type PairIndexLike } from "../pair-index-resolver.ts"

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
 *
 * KNIFE-EDGE, KEPT ON PURPOSE (review follow-up): measured post-bias margin at δ=6.0 is only ~0.211 logits (biased
 * B-dependent_locality 4.592 vs runner-up B-locality 4.380 at the "Fish" piece) — too thin to gate an argmax-flip
 * assertion on (see `GB_WIDE_MARGIN_ADDRESS` for that). Still used for the WIRING assertions below (`pairIndexPath`
 * resolves, `applied` true/false) and the bias-DELTA assertion, both margin-independent.
 */
const GB_DEPENDENT_LOCALITY_ADDRESS = "Beulah Hill, Fishburn, Stockton-on-Tees, TS21 3AB"

/**
 * A real GB (child, parent) pair — "Holland Fen" / "Lincoln", HM Land Registry PPD `CITY`/`DISTRICT` — chosen for the
 * WIDEST post-bias margin found by probing the rung-3 census (`scratchpad/gb-probe-grade/census-gb-pairs.jsonl`, 19,431
 * real pairs) against the shipped `pair-index-gb.bin` (δ=6.0). Method: every pair rendered as `"{Child}, {Parent}"`,
 * `traceParse`d, and scored by (biased B-dependent_locality emission at the child's first piece) − (runner-up label's
 * emission at that same piece) — i.e. the post-bias argmax margin. Top results (comma form unless noted):
 *
 * | rank | pair                              | margin | argmax               |
 * | ---- | --------------------------------- | ------ | -------------------- |
 * | 1    | Holland Fen / Lincoln (no comma)  | 3.488  | B-dependent_locality |
 * | 2    | Holland Park / London (no comma)  | 3.050  | B-dependent_locality |
 * | 3    | Holland Fen / Lincoln             | 2.837  | B-dependent_locality |
 * | 4    | Up Hatherley / Cheltenham         | 2.412  | B-dependent_locality |
 * | 5    | Lower Bullingham / Hereford       | 2.349  | B-dependent_locality |
 * | —    | Shoreditch / London (Task-5 orig) | 0.496  | B-dependent_locality |
 * | —    | Fishburn / Stockton-on-Tees       | 0.211  | B-dependent_locality |
 * | —    | Sedgefield / Stockton-on-Tees     | −1.128 | B-locality (no flip) |
 *
 * "Holland" alone is a country-name confound ("Holland" = Netherlands) — the runner-up label at rank 1/2/6 above is
 * `B-country`/`I-country`, not `B-locality`; the comma-LESS form scored higher than the comma form for both Holland
 * pairs, so this const drops the comma deliberately. A margin of ~3.5 survives a δ recalibration down to ~3 before the
 * flip could invert (post-bias margin at a lower δ' is `margin_at_6.0 − (6.0 − δ')`).
 */
const GB_WIDE_MARGIN_ADDRESS = "Holland Fen Lincoln"

/**
 * Locate the first tokenizer piece belonging to `word` (case-insensitive prefix match on the piece with its `▁`
 * word-start marker stripped) — used to index into `trace.emissions`/`trace.logits` for the bias-DELTA assertion.
 */
function findChildPieceIndex(pieces: ReadonlyArray<{ piece: string }>, word: string): number {
	const needle = word.slice(0, 4).toLowerCase()

	return pieces.findIndex((p) => p.piece.replace(/^▁/, "").toLowerCase().startsWith(needle))
}

/**
 * A `PairIndexLike` stub that never matches — forces the placetype-pair prior OFF for a single `traceParse` call via
 * `opts.placetypePair`, isolating its contribution without touching any other channel/config.
 */
const NO_MATCH_PAIR_INDEX: PairIndexLike = { probe: () => undefined }

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
//
// Review follow-up (see the module docstring's "Task-5 REVIEW FOLLOW-UP" bullet): the wiring assertions
// below never depend on the model's own margin — `applied` reports whether the prior fired, and the
// bias-DELTA assertion measures the prior's OWN contribution against a same-input, prior-forced-off trace.
// Only the LAST test in this block asserts an argmax flip, and it uses `GB_WIDE_MARGIN_ADDRESS` (margin
// ~3.5), not the knife-edge `GB_DEPENDENT_LOCALITY_ADDRESS` (margin ~0.211).
describe("NeuralAddressClassifier.loadFromWeights — placetype-pair prior (Task 5 smoke)", () => {
	test.skipIf(!haveModel || !haveCLI || !haveGBWofDB || !havePPDSource)(
		"en-gb: pairIndexPath resolves and the country-gated default fires (WIRING — margin-independent)",
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
			// `applied` reports EFFECT (a nonzero bias was composed), not argmax victory — true regardless
			// of whether the base model's own preference was thin enough for the bias to flip the decode.
			expect(placetypePairRecord?.applied).toBe(true)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI || !haveGBWofDB || !havePPDSource)(
		"en-gb: the placetype-pair bias at the child token equals the artifact's calibrated delta (margin-independent)",
		async () => {
			const enUSLinkScript = repoRootPath("neural-weights-en-us", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enUSLinkScript], { stdio: "pipe" })

			const enGBLinkScript = repoRootPath("neural-weights-en-gb", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enGBLinkScript], { stdio: "pipe" })

			const r = resolveWeights({ locale: "en-gb" })
			const resolver = new PairIndexResolver(new Uint8Array(readFileSync(r.pairIndexPath!)))

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })

			// Same input, twice: once with the classifier's real (loader-installed) default index, once with
			// `opts.placetypePair` overridden to a stub that never matches — every OTHER channel/config is
			// identical, so the emission delta at the child token isolates the placetype-pair prior's own
			// contribution from the model's own (margin-dependent) belief and from every other prior.
			const biasedTrace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			const unbiasedTrace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS, {
				placetypePair: { index: NO_MATCH_PAIR_INDEX },
			})

			expect(unbiasedTrace.priors.find((p) => p.kind === "placetypePair")?.applied).toBe(false)

			const bDepLocCol = biasedTrace.labels.indexOf("B-dependent_locality")
			expect(bDepLocCol).toBeGreaterThanOrEqual(0)

			const pieceIdx = findChildPieceIndex(biasedTrace.pieces, "Fish")
			expect(pieceIdx).toBeGreaterThanOrEqual(0)

			const delta = biasedTrace.emissions[pieceIdx]![bDepLocCol]! - unbiasedTrace.emissions[pieceIdx]![bDepLocCol]!
			expect(delta).toBeCloseTo(resolver.header.delta, 5)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI || !haveGBWofDB || !havePPDSource)(
		"en-gb: a wide-margin real pair flips the decode — Holland Fen decodes as dependent_locality (the arc's ONE flip assertion)",
		async () => {
			const enUSLinkScript = repoRootPath("neural-weights-en-us", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enUSLinkScript], { stdio: "pipe" })

			const enGBLinkScript = repoRootPath("neural-weights-en-gb", "scripts", "link-dev-weights.ts")
			execFileSync(process.execPath, ["--experimental-strip-types", enGBLinkScript], { stdio: "pipe" })

			const r = resolveWeights({ locale: "en-gb" })
			const resolver = new PairIndexResolver(new Uint8Array(readFileSync(r.pairIndexPath!)))
			// Setup precondition, per the brief: confirm the pair is genuinely PROBE OK in THIS build before
			// trusting the parse below to prove anything about the flip. "Holland Fen" is folded to a
			// SPACE-preserved token ("holland fen"), not concatenated — see pair-index-resolver.ts's header
			// doc on how normalizeFSTToken folds interior whitespace.
			expect(resolver.probe("holland fen", "lincoln")).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const json = await cls.parseJSON(GB_WIDE_MARGIN_ADDRESS)
			expect(json.dependent_locality).toBe("Holland Fen")
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
