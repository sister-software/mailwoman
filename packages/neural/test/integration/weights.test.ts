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
 *       must fall through to the en-us package dir (`source` suffixed `+base`) while its OWN
 *       `pair-index-gb.bin` resolves locally. As of 6.7.0 en-gb ALSO ships its own `model-card.json`
 *       (#1249's overlay-local path), so the card-less fallback for `modelCardPath` is dormant for en-gb
 *       (model/tokenizer still fall through to base; only the card resolves locally, per
 *       `resolveFromPackageDir`'s precedence). Since 2026-08-05 (#1467) en-gb ALSO asserts NO anchor
 *       lookup, and both halves of that — the resolver's answer and the `files` manifest — are pinned:
 *       the encoder's GB anchor slot is untrained, so re-adding `postcode-gb.bin` without a retrain is
 *       a silent regression, and these are the two assertions that make it loud.
 *   - The en-nz case is the same base-overlay dedup, and since the en-gb mitigation the two locales
 *       carry the SAME postcode-less posture for two DIFFERENT reasons — worth keeping straight. en-nz
 *       ships no `postcode-nz.bin` because no WOF NZ postcode extract exists to build one from (a data
 *       gap, see that overlay's `no_postcode_bin` follow-up); en-gb ships none because the extract exists
 *       and feeding it makes GB parses worse (a training gap). Same `anchorLookupPath === undefined`
 *       assertion, opposite repair.
 *   - The placetype-pair-prior block is the arc's end-to-end smoke: en-gb resolves
 *       `pairIndexPath`, `loadFromWeights` constructs a country-restricted `PairIndexResolver` default, and a
 *       real GB dependent_locality address parses with the tag applied. A companion case proves the
 *       prior is INERT on en-us (no sibling shipped) against the identical GB-shaped input.
 *   - MARGIN DISCIPLINE in that same "placetype-pair prior" describe block: a single argmax flip on
 *       `GB_DEPENDENT_LOCALITY_ADDRESS` is NOT a safe thing to assert, because its measured margin at the
 *       shipped δ=6.0 is only ~0.211 logits — any future recalibration of that delta flips the assertion
 *       for reasons having nothing to do with wiring correctness. So the block runs in three tiers: (a)
 *       WIRING assertions (pairIndexPath resolves; `applied` true/false) stay on the knife-edge address and
 *       are margin-independent by construction — `applied` reports whether the prior fired, not whether it
 *       won; (b) a bias-DELTA assertion compares the biased trace against a same-input trace with the
 *       prior forced off (a no-match `PairIndexLike` stub passed via `opts.placetypePair`), so the measured
 *       delta at the child token isolates the prior's own contribution — margin-independent, and provable
 *       without ever touching the model's own unbiased preference; (c) exactly one flip assertion, on
 *       `GB_WIDE_MARGIN_ADDRESS` — a real census pair chosen by probing candidates from
 *       `scratchpad/gb-probe-grade/census-gb-pairs.jsonl` for the widest post-bias margin (see that
 *       const's docstring for the measured candidate table). Margin ≥~3 survives a δ recalibration down to
 *       ~3 before the flip could invert.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { $public } from "@mailwoman/core/env"
import { readDirectory, readLocalBuffer, readLocalJSONFile, pathExists, isFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { runFileSync } from "@mailwoman/core/process"
import { NeuralAddressClassifier, resolveWeights } from "@mailwoman/neural"
import { PairIndexResolver, serializePairIndex, type PairIndexLike } from "@mailwoman/neural/pair"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { dirname, join } from "path-ts"
import { afterAll, describe, expect, test, vi } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const TOKENIZER_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

const MODEL_PATH =
	$public.MAILWOMAN_TEST_ONNX_MODEL ??
	String(dataRootPath("models", "quantized", "model-stage1-coarse-step-050000-int8.onnx"))

const haveModel = await pathExists(MODEL_PATH)

/**
 * Run each locale's `link-dev-weights.ts` at most ONCE per process.
 *
 * The scripts are idempotent — they symlink the dev artifacts into the workspace and, on a cold cache, shell out to the
 * compiled CLI to rebuild a stale `postcode-<cc>.bin` / `pair-index-<cc>.bin` behind a freshness guard. Eighteen call
 * sites in this file were invoking them, most in pairs, for a result that cannot change after the first: measured
 * 2026-08-02 the file was 96.6s of a 253s CI leg.
 *
 * The rebuild semantics survive memoization. The first call does the freshness check and any rebuild; every later call
 * was re-verifying state the first one already made fresh, and no test asserts the ACT of re-linking. Nothing in this
 * file deletes a real `neural-weights-*` artifact mid-run (the two `rmSync`/`symlinkSync` sites work on temp fixtures),
 * so the memo cannot go stale underneath a later test. If that ever changes, this is what has to be reconsidered.
 *
 * Deliberately lazy rather than a top-level `beforeAll`: every caller is `skipIf`-conditioned on the dev model being
 * present, and a `beforeAll` would spawn the scripts even where all of them skip.
 */
const linkedLocales = new Set<string>()

function ensureDevWeightsLinked(...locales: readonly string[]): void {
	for (const locale of locales) {
		if (linkedLocales.has(locale)) continue

		runFileSync(process.execPath, [workspacePath(`neural-weights-${locale}`, "scripts", "link-dev-weights.ts")], {
			stdio: "pipe",
		})

		linkedLocales.add(locale)
	}
}

// Every locale's link-dev-weights.ts shells out to the compiled CLI for its derived artifacts, so the
// CLI must be built. Detected the same way `haveModel` is: existsSync through the repo's data-root
// helpers, never a hardcoded path.
//
// There is deliberately NO `haveGBWofDB` guard any more (2026-08-05): en-gb stopped building
// postcode-gb.bin, so the GB WOF postcode extract is no longer a precondition for any test here — and
// a guard that names a file nothing reads skips tests for a reason that no longer exists.
const CLI_PATH = workspacePath("mailwoman", "out", "cli.js")
const haveCLI = await pathExists(CLI_PATH)

// The en-gb smoke's link-dev-weights run ALSO shells out to `gazetteer pair-index` to build
// pair-index-gb.bin from the PPD tuples CSV (see that script's header) — needs the source CSV on disk
// same as the postcode-binary build needs the WOF extract above.
const PPD_SOURCE_CSV_PATH = dataRootPath("ppd", "2026-07-22", "gb-tuples.csv")
const havePPDSource = await pathExists(String(PPD_SOURCE_CSV_PATH))

// The en-nz auto-resolve test's link-dev-weights run shells out to `gazetteer pair-index` to build
// pair-index-nz.bin from the LINZ-derived OpenAddresses NZ countrywide CSV (see that script's
// header) — same on-disk precondition shape as the GB PPD source above.
const NZ_SOURCE_CSV_PATH = dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv")
const haveNZSource = await pathExists(String(NZ_SOURCE_CSV_PATH))

// Every test that shells out to a link-dev-weights.ts needs this, for two different cold-start
// costs. en-gb builds pair-index-gb.bin from the ~25.6M-row PPD tuples CSV — several minutes. en-us
// verifies its pair-index against the 5.2 GB admin-global-priority.db, and with no `.md5` sidecar
// yet that is a full hash of the file. Both are FIRST-run costs (each script has a skip-if-current
// fast path), and both are far past vitest's 15s global default. Generous, not a perf target.
const LINK_SCRIPT_TIMEOUT_MS = 600_000

/**
 * A real GB address whose middle place ("Fishburn") is a verified PROBE OK (child, parent) pair in the shipped
 * `pair-index-gb.bin` ("Fishburn" / "Stockton-on-Tees" → dependent_locality). Deliberately house-number-less: with a
 * leading house number ("14 Beulah Hill, …") the base model's own B-locality logit for "Fishburn" is confident enough
 * (raw gap ~6.9) that the +6.0 pair-index delta narrows but does not flip it — this phrasing's unbiased margin is
 * narrow enough for the prior to decide it, which is exactly what an end-to-end smoke should demonstrate.
 *
 * KNIFE-EDGE, KEPT ON PURPOSE: measured post-bias margin at δ=6.0 is only ~0.211 logits (biased B-dependent_locality
 * 4.592 vs runner-up B-locality 4.380 at the "Fish" piece) — too thin to gate an argmax-flip assertion on (see
 * `GB_WIDE_MARGIN_ADDRESS` for that). Still used for the WIRING assertions below (`pairIndexPath` resolves, `applied`
 * true/false) and the bias-DELTA assertion, both margin-independent.
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
 * | —    | Shoreditch / London (also probed) | 0.496  | B-dependent_locality |
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
	test.skipIf(!haveModel)("returns the explicit paths verbatim when both are valid", async () => {
		const r = await resolveWeights({ modelPath: MODEL_PATH, tokenizerPath: TOKENIZER_PATH })
		expect(r.modelPath).toBe(MODEL_PATH)
		expect(r.tokenizerPath).toBe(TOKENIZER_PATH)
		expect(r.source).toBe("explicit")
	})

	test("throws actionably when explicit modelPath is missing", async () => {
		await expect(resolveWeights({ modelPath: "/no/such/model.onnx", tokenizerPath: TOKENIZER_PATH })).rejects.toThrow(
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
	// FST-distribution arc (2026-07-25): the per-locale FST gazetteer resolves as a PATH sibling
	// (`fst-<locale>.bin`) — neural exposes it verbatim (`classifier.fstPath`); the mailwoman runtime
	// pipeline deserializes + auto-wires it from there. A package without the sibling (en-nz) leaves
	// fstPath undefined — byte-stable.
	test.skipIf(!haveModel)(
		"surfaces fstPath for a weights package shipping fst-<locale>.bin",
		async () => {
			ensureDevWeightsLinked("en-us")

			const r = await resolveWeights({ locale: "en-us" })
			expect(r.fstPath).toMatch(/\/fst-en-us\.bin$/)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel)(
		"finds model.onnx + tokenizer.model after running link-dev-weights.ts",
		async () => {
			ensureDevWeightsLinked("en-us")

			const r = await resolveWeights({ locale: "en-us" })
			// WHICH RUNG answered is an environment fact, not the contract. The dev linkers materialize into
			// $MAILWOMAN_DATA_ROOT/weights/<locale>/, so a checkout resolves `overlay:`; a consumer with the npm
			// package installed resolves `package:`; a `--download-weights` install resolves `cache:`. Pinning one
			// of them asserts how this machine happens to be set up.
			expect(r.source).toMatch(/^(package|overlay|cache):/)
			expect(r.modelPath).toMatch(/\/model\.onnx$/)
			expect(r.tokenizerPath).toMatch(/\/tokenizer\.model$/)
			// v0.4.0: the resolver surfaces model-card.json so loadFromWeights can read
			// the trained label vocabulary from it (issue #116 §5(a)).
			expect(r.modelCardPath).toMatch(/\/model-card\.json$/)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	// #1177 base-overlay dedup, en-gb form: model/tokenizer resolve from the en-us base
	// (mailwoman.baseWeights) while the overlay's own card + pair index resolve locally.
	//
	// The anchor assertion is INVERTED as of 2026-08-05 (#1467) and that inversion is the point of the
	// test. This case used to assert `anchorLookupPath` pointed at a local `postcode-gb.bin`. It now
	// asserts the opposite, because the encoder's GB anchor slot (slot 4 of LOCALE_ORDER) never received
	// training gradient — every recipe fed the same US/DE/FR-only pilot lookup — so shipping GB anchors
	// pushed every GB parse along an untrained input direction. Measured: exact postcode 294/318 with the
	// binary present vs 318/318 with it absent, on the gb-golden board across three registers.
	//
	// So this assertion is a regression check, not a description: the failure it exists to catch is someone
	// re-adding postcode-gb.bin — to `files`, to release.config.json's postcodeDBByCountry, to the
	// publish workflow's fetch list, or by hand into the package dir — WITHOUT the retrain that feeds
	// slot 4. That change produces no error and no warning on its own; it just quietly makes GB worse.
	// 9.0.0 (ROAD_TO_V9 A4): the GB anchor slot is TRAINED (v4.2.0 base, Fisher receipts in the
	// en-gb card) and postcode-gb.bin is back — the card declares span_mode "shaped" and the dev
	// linker builds the bin off that card gate. The #1467 "has NO anchor lookup" posture this test
	// pinned from 2026-08-05 lives on in the card's gb_artifacts history.
	test.skipIf(!haveModel || !haveCLI)(
		"en-gb resolves model/tokenizer from the en-us base with its own model-card, resolves the RETURNED postcode-gb.bin, and parses",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			// `+base` is exercised hermetically below; here the point is that en-gb RESOLVES.
			expect(r.source).toMatch(/^(package|overlay):/)
			expect(r.modelPath).toMatch(/\/model\.onnx$/)
			expect(r.tokenizerPath).toMatch(/\/tokenizer\.model$/)
			expect(r.anchorLookupPath?.binary).toBe(true)
			expect(r.anchorLookupPath?.path).toMatch(/\/postcode-gb\.bin$/)
			// Overlay-local card (6.7.0): en-gb ships its own model-card.json (a verbatim copy of the
			// base's labels/requires apart from the deliberate conventions + anchor deviations — see that
			// file's header comment), so `resolveFromPackageDir` resolves it LOCALLY instead of falling
			// through to the en-us base card. The label vocab is byte-identical either way (STAGE3+, 33
			// labels), so `assertEmissionWidth` never trips.
			expect(r.modelCardPath).toMatch(/\/model-card\.json$/)

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const tree = await cls.parse("10 Downing Street, London SW1A 2AA")
			expect(tree.roots.length).toBeGreaterThan(0)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	// The packaging half of the same regression check. The assertion above reads the RESOLVER's answer, which is
	// derived from the package DIRECTORY; this one reads the package MANIFEST. They can disagree — a
	// tarball ships what `files` names, a dev worktree resolves what is on disk — and each failure mode
	// has its own repair, so neither assertion substitutes for the other.
	// Restated 2026-08-06 (ROAD_TO_V9 §1 A4) as a COUPLING rather than a bare absence. #1467's rule was
	// "en-gb ships no postcode binary", which was right for a model whose GB anchor slot took no
	// gradient — but it is a rule with an expiry date, and a flat `not.toContain` gives the promotion
	// no way to satisfy it except by deletion. The durable invariant underneath is the pairing: the
	// binary's unit keys are only REACHABLE when the card declares `span_mode: "shaped"`, so the two
	// must move together. Ship the bin under a non-shaped card and every GB parse feeds an untrained
	// input direction (the measured 24-postcode regression); declare shaped without the bin and the
	// channel is simply off. Each half is checkable, and neither alone is the contract.
	test("neural-weights-en-gb names a postcode binary in `files` IFF its card declares span_mode shaped", async () => {
		const manifest = await readLocalJSONFile<{ files: string[] }>(workspacePath("neural-weights-en-gb", "package.json"))

		const card = await readLocalJSONFile<{ requires?: { anchor?: { span_mode?: string } } }>(
			workspacePath("neural-weights-en-gb", "model-card.json")
		)

		const shaped = card.requires?.anchor?.span_mode === "shaped"
		expect(manifest.files.filter((entry) => entry.startsWith("postcode-"))).toEqual(shaped ? ["postcode-gb.bin"] : [])
		// The pair-prior capability is untouched by the anchor mitigation — pinned so a future
		// "clean up the GB overlay" pass cannot take both out in one sweep.
		expect(manifest.files).toContain("pair-index-gb.bin")
	})

	// Base-overlay dedup, en-nz form: model/tokenizer/lexicon-less resolution details are all shared
	// with the en-gb case above — what's NEW here is the postcode-less posture. en-nz ships NO
	// postcode-nz.bin (no WOF NZ postcode extract exists — the overlay's model-card `no_postcode_bin`
	// follow-up), so `anchorLookupPath` must come back undefined while `pair-index-nz.bin` and the
	// overlay-local model-card still resolve from the package dir. Wiring-only, one test — the
	// prior/country-gate behavior itself is generic implementation already covered by the en-gb prior
	// block below and the mispackaging gate at the bottom of this file.
	test.skipIf(!haveModel || !haveCLI || !haveNZSource)(
		"en-nz resolves model/tokenizer from the en-us base + pair-index-nz.bin locally, with NO anchor lookup (no NZ postcode extract), and parses",
		async () => {
			ensureDevWeightsLinked("en-us", "en-nz")

			const r = await resolveWeights({ locale: "en-nz" })
			expect(r.source).toMatch(/^(package|overlay):/)
			expect(r.modelPath).toMatch(/\/model\.onnx$/)
			expect(r.tokenizerPath).toMatch(/\/tokenizer\.model$/)
			// The documented gap, pinned: no postcode-nz.bin ships, so the anchor sibling must NOT
			// resolve (loadFromWeights then warns once and runs anchor-OFF — the tolerant-loader
			// contract, not a crash).
			expect(r.anchorLookupPath).toBeUndefined()
			expect(r.modelCardPath).toMatch(/\/model-card\.json$/)
			expect(r.pairIndexPath).toMatch(/\/pair-index-nz\.bin$/)

			// Probe the built artifact directly: header country checks to nz, and a known identity pair
			// (the NZ repeated-name convention — 255/1178 census pairs are (x,x)) is
			// genuinely present in THIS build.
			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))
			expect(resolver.header.country).toBe("nz")
			expect(resolver.header.delta).toBe(10)
			expect(resolver.probe("plimmerton", "porirua")?.tag).toBe("dependent_locality")
			expect(resolver.probe("mangawhai", "mangawhai")?.tag).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-nz" })
			const tree = await cls.parse("7 Katipo Drive, Mangawhai, Northland")
			expect(tree.roots.length).toBeGreaterThan(0)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)
})

// placetype-pair-prior arc: the arc's end-to-end proof. `pairIndexPath` resolves on en-gb,
// `loadFromWeights` constructs a country-restricted `PairIndexResolver` default from it, and a real GB
// dependent_locality address decodes with the tag applied. The en-us companion proves the SAME input
// produces NO bias when the package ships no sibling index — the prior degrades to byte-stable, not to
// a crash or a silent wrong-country apply.
//
// Margin discipline (see the module docstring's MARGIN DISCIPLINE bullet): the wiring assertions
// below never depend on the model's own margin — `applied` reports whether the prior fired, and the
// bias-DELTA assertion measures the prior's OWN contribution against a same-input, prior-forced-off trace.
// Only the LAST test in this block asserts an argmax flip, and it uses `GB_WIDE_MARGIN_ADDRESS` (margin
// ~3.5), not the knife-edge `GB_DEPENDENT_LOCALITY_ADDRESS` (margin ~0.211).
describe("NeuralAddressClassifier.loadFromWeights — placetype-pair prior (smoke)", () => {
	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: pairIndexPath resolves and the country-restricted default fires (WIRING — margin-independent)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			expect(r.pairIndexPath).toMatch(/\/pair-index-gb\.bin$/)

			// Probe the built artifact directly FIRST (per the brief) — establishes that
			// ("fishburn", "stocktonontees") is genuinely a PROBE OK pair in THIS build before trusting
			// the end-to-end parse below to prove anything about the wiring.
			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))
			expect(resolver.header.country).toBe("gb")
			expect(resolver.probe("fishburn", "stocktonontees")?.tag).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const trace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			const placetypePairRecord = trace.priors.find((p) => p.kind === "placetypePair")
			// `applied` reports EFFECT (a nonzero bias was composed), not argmax victory — true regardless
			// of whether the base model's own preference was thin enough for the bias to flip the decode.
			expect(placetypePairRecord?.applied).toBe(true)
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: the placetype-pair bias at the child token equals the artifact's calibrated delta (margin-independent)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))

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

	// The typed disable (`ParseOpts.placetypePair: false`) — the real "turn an AUTO-WIRED config
	// default off for one call" mechanism, and distinct from the `NO_MATCH_PAIR_INDEX` stub above in
	// that it is a disable signal type-checkable as one. See
	// `placetype-pair-prior.ts`'s module docstring ("Disable semantics") for the three-case contract this
	// pins the middle case of: a config default IS auto-wired here (en-gb), so `false` is doing real work,
	// not just matching an already-inert default.
	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: explicit `placetypePair: false` disables the auto-wired config default for one call (trace applied:false)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })

			// Baseline: no per-call override — the config default fires (confirms this address/build genuinely
			// has something to disable, not just asserting on an already-inert prior).
			const wiredTrace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			expect(wiredTrace.priors.find((p) => p.kind === "placetypePair")?.applied).toBe(true)

			// `placetypePair: false` — inert regardless of the auto-wired default.
			const disabledTrace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS, { placetypePair: false })

			expect(disabledTrace.priors.find((p) => p.kind === "placetypePair")).toEqual({
				kind: "placetypePair",
				applied: false,
			})

			// Not just "applied: false" — the emissions themselves must be byte-identical to a genuinely
			// prior-absent decode, not merely a zero-effect bias composed in.
			const bDepLocCol = disabledTrace.labels.indexOf("B-dependent_locality")
			const pieceIdx = findChildPieceIndex(disabledTrace.pieces, "Fish")
			expect(disabledTrace.emissions[pieceIdx]![bDepLocCol]).toBe(disabledTrace.logits[pieceIdx]![bDepLocCol])
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: a wide-margin real pair flips the decode — Holland Fen decodes as dependent_locality (the arc's ONE flip assertion)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))
			// Setup precondition: confirm the pair is genuinely PROBE OK in THIS build before
			// trusting the parse below to prove anything about the flip. "Holland Fen" is folded to a
			// SPACE-preserved token ("holland fen"), not concatenated — see pair-index-resolver.ts's header
			// doc on how normalizeFSTToken folds interior whitespace.
			expect(resolver.probe("holland fen", "lincoln")?.tag).toBe("dependent_locality")

			// GB_WIDE_MARGIN_ADDRESS is deliberately comma-LESS (see its docstring — the comma form scored
			// LOWER for this exact pair). The prior defaults to `probeMode: "segment"`, under which a
			// comma-free three-word input is one inert segment — no bias, no flip. This is the window-mode
			// sub-window behavior on purpose, so `probeMode: "window"` (the opt-in mode) is passed
			// explicitly, reusing the SAME real resolver already probed above as the per-parse override.
			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })

			const json = await cls.parseJSON(GB_WIDE_MARGIN_ADDRESS, {
				placetypePair: { index: resolver, probeMode: "window" },
			})

			expect(json.dependent_locality).toBe("Holland Fen")
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	// TRANSITION-BETA characterization (operator-approved build 2026-07-24): a real comma-free GB register
	// row from the probe's 17-row fused-path population. Measured against the model 7.0.0 from-scratch base
	// (both legs per row against scratchpad/en-nz-ship-verify/transition-probe-rows.json), 15 of the 17
	// rows self-recover BETA-LESS — including Hedon and Ashby Parva, which never recovered at any β on the
	// fine-tune lineage. Glenfield (margin 3.10) was the pinned discriminator on that base.
	//
	// STALENESS TRAP, and it has bitten this test before: the pin is graded against a LOCALLY BUILT index,
	// so a stale artifact keeps the test green while the row it names has quietly started self-recovering
	// beta-less ("Upton"/"Bude" did exactly that). `link-dev-weights.ts`'s freshness guard therefore
	// compares EVERY entry of `sourceMD5s`, not just `[0]` — checking the CSV alone leaves it blind to a
	// new source joining the index (a borough DB, a checked-in London pair set) — and the CI cache key has
	// to track the same set. A pass here is only as trustworthy as the artifact's freshness.
	//
	// THE CONTRAST RETIRED AT THE 9.1.0 RELEASE (2026-08-11): under the v4.4.0 suffix-boundary base, the
	// discriminator population is EMPTY as far as a fresh 191-pair PPD sweep can see — 190/191 rows
	// recover the dependent locality in BOTH legs (Glenfield included), 0 rows need β, 0 rows regress
	// with β on, 1 row misses in both. There is no row to move the pin to, so the beta-less leg now
	// asserts the measured self-recovery instead of a miss. The artifact keeps β=5 as insurance
	// (harmless by the same sweep). If a future base regresses this class, the failure lands on the
	// beta-less assertion below — re-run the sweep (both legs over PPD five-field rows whose pair
	// probes to dependent_locality) and re-pin a discriminator the way Glenfield once was.
	test.skipIf(!haveModel || !haveCLI || !havePPDSource)(
		"en-gb: the transitionBeta=5 artifact carries its header contract; the comma-free fused-path row recovers in both legs (TRANSITION-BETA)",
		async () => {
			ensureDevWeightsLinked("en-us", "en-gb")

			const r = await resolveWeights({ locale: "en-gb" })
			const resolver = new PairIndexResolver(new Uint8Array(await readLocalBuffer(r.pairIndexPath!)))

			// The rebuild artifact's header contract: delta stays 10, transitionBeta 5 (the link script's
			// PAIR_INDEX_TRANSITION_BETA lockstep guard rebuilds a stale binary before this line can see it).
			expect(resolver.header.delta).toBe(10)
			expect(resolver.header.transitionBeta).toBe(5)
			expect(resolver.probe("upton", "bude")?.tag).toBe("dependent_locality")

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })
			const row = "12 Church Road Glenfield Leicester LE3 8DP"

			// Beta-less view of the SAME index bytes: probe + delta identical, transitionBeta (and parentDelta,
			// which arrived with the same generation of levers) withheld. On the 7.0.0 base this leg pinned the
			// pre-β miss; on the v4.4.0 base the 2026-08-11 sweep measured 190/191 PPD rows recovering in both
			// legs, so the leg now asserts the self-recovery — the wiring proof (applied:true) is unchanged, and
			// a regression of this class fails HERE first (see the header comment for the re-pin recipe).
			const betaLessView: PairIndexLike = { probe: (c, p) => resolver.probe(c, p), delta: resolver.delta }

			const betaLessTrace = await cls.traceParse(row, { placetypePair: { index: betaLessView } })
			expect(betaLessTrace.priors.find((p) => p.kind === "placetypePair")?.applied).toBe(true)
			const betaLessJSON = await cls.parseJSON(row, { placetypePair: { index: betaLessView } })
			expect(betaLessJSON.dependent_locality).toBe("Glenfield")

			// The auto-wired config default (the shipped artifact, beta 5) recovers the row.
			const json = await cls.parseJSON(row)
			expect(json.dependent_locality).toBe("Glenfield")
		},
		LINK_SCRIPT_TIMEOUT_MS
	)

	test.skipIf(!haveModel || !haveCLI)(
		"en-us: ships its OWN us-gated pair index — a GB-shaped input still applies NO placetype-pair bias",
		async () => {
			// en-us ships `pair-index-us.bin` (49,033 WOF-sourced pairs), so the property worth protecting is not the
			// packaging fact that no sibling exists — it does exist — but that the index is still INERT on GB input.
			// Two independent things keep it inert — the header's hard country restriction, and the plain fact that US pairs
			// don't contain GB place names (measured: the US index misses all five GB canonical pairs).
			ensureDevWeightsLinked("en-us")

			const r = await resolveWeights({ locale: "en-us" })
			expect(r.pairIndexPath).toMatch(/pair-index-us\.bin$/)

			const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
			const trace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
			const placetypePairRecord = trace.priors.find((p) => p.kind === "placetypePair")
			expect(placetypePairRecord?.applied).toBe(false)
		}
	)
})

// The hard country restriction's WARN branch (classifier.ts loadFromWeights): a pair-index sibling whose
// PIX1 header country disagrees with the resolved locale's country is a PACKAGING error — the eval
// must warn + skip the prior default, and the load must still succeed (skip-not-throw). Unreachable
// through a correctly-built package (resolvePairIndexSibling matches on the locale's own country
// code), so the test manufactures the mispackaging: a cacheRoot package layout whose
// `pair-index-us.bin` carries a "gb" header.
describe("loadFromWeights — pair-index country gate (warn branch)", () => {
	test.skipIf(!haveModel)(
		"mispackaged sibling (header country ≠ locale country) warns and skips the prior",
		async () => {
			// Guarantee the en-us workspace has its dev binaries materialized, then mirror the package
			// into a temp cacheRoot layout via symlinks (cacheDir = <cacheRoot>/node_modules/<pkg>).
			ensureDevWeightsLinked("en-us")

			// ASK THE RESOLVER where the artifacts are. This used to name the workspace directory, which held
			// them only while the dev linkers materialized into the tracked package; they now land in the
			// data-root overlay, and a fixture mirroring an empty directory produces a cache with no binaries —
			// so the resolve under test silently answers from somewhere else and the eval never fires.
			const packageDir = dirname((await resolveWeights({ locale: "en-us" })).modelPath)
			const cacheRoot = fixtures.use(await temporaryDirectory("mailwoman-pair-gate-")).path
			const fakePackageDir = weightsCachePackageDir(cacheRoot, "en-us")
			await makeDirectories(fakePackageDir)

			for (const entry of await readDirectory(packageDir)) {
				const source = join(packageDir, entry)

				// NEVER symlink the artifact this test is about to overwrite. `writeFileSync` FOLLOWS a symlink, so
				// once en-us started shipping a real `pair-index-us.bin` (campaign R5), symlinking it here would have
				// clobbered the 49,033-pair production binary with the 1-entry stub below — silently, since the test
				// still passes and every later test in the run would grade against the corrupted file. Same
				// write-through-the-symlink hazard AGENTS.md documents for `fs.copyFile` in the publish path.
				if ((await isFile(source)) && entry !== "pair-index-us.bin") {
					await createSymbolicLink(source, join(fakePackageDir, entry))
				}
			}

			// The mispackaged artifact: named for en-us's country, but the header says gb.
			await writeLocalFile(
				serializePairIndex(
					{
						country: "gb",
						delta: 5,
						foldVersion: 1,
						sourceMD5s: [],
						buildDate: "2026-07-23",
					},
					[{ child: "holland fen", parent: "boston", tag: "dependent_locality", parentTag: "locality" }]
				),
				join(fakePackageDir, "pair-index-us.bin")
			)

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			try {
				// The sibling RESOLVES (filename matches the locale's country) — the eval is downstream.
				const r = await resolveWeights({ locale: "en-us", cacheRoot })
				expect(r.pairIndexPath).toMatch(/pair-index-us\.bin$/)

				const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us", cacheRoot })

				expect(
					warnSpy.mock.calls.some(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes('pair-index country "gb"') &&
							call[0].includes(`does not match the resolved locale's country "us"`)
					)
				).toBe(true)

				// Skip-not-throw: the prior default was NOT constructed, and parsing still works.
				const trace = await cls.traceParse(GB_DEPENDENT_LOCALITY_ADDRESS)
				const placetypePairRecord = trace.priors.find((p) => p.kind === "placetypePair")
				expect(placetypePairRecord?.applied).toBe(false)

				const tree = await cls.parse("75004 Paris")
				expect(tree.roots.length).toBeGreaterThan(0)
			} finally {
				warnSpy.mockRestore()
			}
		},
		LINK_SCRIPT_TIMEOUT_MS
	)
})
