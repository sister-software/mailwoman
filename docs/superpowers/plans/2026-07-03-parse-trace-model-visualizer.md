# Parse Trace + ModelVisualizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A serializable `NeuralParseTrace` produced by the shared decode path (`traceParse` on `NeuralAddressClassifier`), rendered by a docs `<ModelVisualizer>` component fed from production assets.

**Architecture:** Increments 1+2 of the approved spec (`docs/superpowers/specs/2026-07-03-parse-trace-model-visualizer-design.md`). The private `#decode` in `neural/classifier.ts` gains a trace flag that _retains_ intermediates it already computes (no fork — #481 invariant); a new public `traceParse` assembles them into `NeuralParseTrace`. Docs side: a pure `<ModelVisualizer trace={…}/>` renders four bands + a locale gauge, and a thin `LiveModelVisualizer` wires it to `useDemoEmbed()`. CLI + resolver stages are a **separate later plan** (spec increments 3–4).

**Tech Stack:** TypeScript (tabs, workspace-root files, license headers), vitest, React 18 + CSS modules (docs), Storybook (`@storybook/react-vite`), Docusaurus.

## Global Constraints

- **Git on this machine:** `~/.gitconfig` is TCC-blocked. Every git write: `export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` then `git -c user.name="Teffen Ellis" -c user.email="teffen@sister.software" commit …`. Commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **#481 invariant:** `#decode` stays the single decode path. Trace capture happens inside it, gated on a flag. `parse` / `parseWithLogits` must stay byte-stable — the existing neural suite is the guard and must pass untouched.
- **File conventions:** every new `.ts`/`.tsx` file starts with the 4-line `@copyright Sister Software / @license AGPL-3.0 / @author Teffen Ellis, et al.` docblock plus a purpose paragraph. Indentation is tabs. Workspace files live at workspace root (no `src/`); docs components live in `docs/src/components/<Name>/`.
- **Acronym casing:** whole-component caps (`parseJSON`, not `parseJson`). No new acronym identifiers are expected in this plan; if one appears, cap it whole.
- **Docs type discipline:** `docs/src/shared/resources.tsx` uses locally-defined structural `*Like` types — do NOT import types from `@mailwoman/neural` into docs.
- **Run TS directly:** `node --experimental-strip-types <file>` for scripts; `yarn vitest --run <path>` for tests (root vitest config resolves the `@mailwoman/*` source aliases).

---

### Task 1: `NeuralParseTrace` + `traceParse` on the shared decode path

**Files:**

- Create: `neural/trace.ts`
- Modify: `neural/classifier.ts` (imports; `#decode` signature/return; new `traceParse`)
- Modify: `neural/index.ts` (add `export * from "./trace.js"`)
- Test: `neural/test/trace-parse.test.ts`

**Interfaces:**

- Consumes: `#decode(text, opts)` internals as they exist today (`neural/classifier.ts:348-509`), `SoftFeatureChannel` (`neural/soft-features.ts:26`), `DecoderToken` (`@mailwoman/core/decoder`), `SystemCode` (`@mailwoman/codex`).
- Produces: `traceParse(text: string, opts?: ParseOpts): Promise<NeuralParseTrace>` and the exported types `NeuralParseTrace`, `TracePiece`, `TracePrior`, `TracePriorKind`, `TraceRepair`, `TraceRepairPass`. Task 2's script and Task 3's docs types depend on these exact names/fields.

- [ ] **Step 1: Write the failing test**

Create `neural/test/trace-parse.test.ts`. It follows the house pattern from `neural/test/classifier-query-shape.test.ts`: real tokenizer fixture + fake runner, no model file.

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for `NeuralAddressClassifier.traceParse` (spec:
 *   docs/superpowers/specs/2026-07-03-parse-trace-model-visualizer-design.md).
 *
 *   The load-bearing assertion is PARITY: the trace's tokens must build the same AddressTree
 *   `parse()` returns under identical opts — proving trace retention never forked the decode
 *   path (#481). Uses a fake `NeuralRunner` so the suite runs in milliseconds.
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildAddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { NeuralAddressClassifier, type NeuralRunner } from "../classifier.js"
import { STAGE2_BIO_LABELS } from "../labels.js"
import type { InferResult } from "../onnx-runner.js"
import { MailwomanTokenizer } from "../tokenizer.js"

const here = dirname(fileURLToPath(import.meta.url))
const TOKENIZER_PATH = resolve(here, "fixtures/tokenizer-v0.1.0.model")

/** Fake runner emitting a canned logits matrix (and optional locale head) regardless of input. */
class FakeRunner implements NeuralRunner {
	constructor(
		private readonly canned: number[][],
		private readonly localeLogits?: number[]
	) {}
	async infer(_ids: number[]): Promise<InferResult> {
		return {
			logits: this.canned,
			numLabels: this.canned[0]?.length ?? 0,
			...(this.localeLogits ? { localeLogits: this.localeLogits } : {}),
		}
	}
}

/** Uniform-noise logits with a boost on one label at one token index. */
function logitsWithBoost(numTokens: number, boostIdx: number, boostLabel: string, magnitude = 3): number[][] {
	const labelIdx = STAGE2_BIO_LABELS.indexOf(boostLabel as (typeof STAGE2_BIO_LABELS)[number])
	const matrix: number[][] = []

	for (let t = 0; t < numTokens; t++) {
		const row = new Array<number>(STAGE2_BIO_LABELS.length).fill(0)

		if (t === boostIdx && labelIdx >= 0) row[labelIdx] = magnitude
		matrix.push(row)
	}

	return matrix
}

async function loadTokenizer(): Promise<MailwomanTokenizer> {
	return MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
}

describe("NeuralAddressClassifier.traceParse", () => {
	it("parity: trace tokens rebuild the exact tree parse() returns", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave 10118"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-house_number")
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const tree = await classifier.parse(text)
		const trace = await classifier.traceParse(text)

		expect(buildAddressTree(trace.text, trace.tokens)).toEqual(tree)
	})

	it("surfaces raw logits, pieces, labels, and viterbi path", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave 10118"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-house_number")
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const trace = await classifier.traceParse(text)

		expect(trace.logits).toEqual(logits)
		expect(trace.pieces).toHaveLength(pieces.length)
		expect(trace.pieces[0]).toEqual({
			piece: pieces[0]!.piece,
			id: pieces[0]!.id,
			start: pieces[0]!.start,
			end: pieces[0]!.end,
		})
		expect(trace.labels).toEqual([...STAGE2_BIO_LABELS])
		expect(trace.path).toHaveLength(pieces.length)
		expect(trace.decode).toBe("viterbi")
		expect(trace.tokens).toHaveLength(pieces.length)
	})

	it("records which priors fired", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave 10118"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-house_number")
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const bare = await classifier.traceParse(text)
		const queryShapePrior = bare.priors.find((p) => p.kind === "queryShape")

		expect(queryShapePrior).toEqual({ kind: "queryShape", applied: false })

		// The span proposer is default-ON; whether it fires depends on the text. The contract
		// here is presence + a boolean, not a specific value.
		for (const kind of ["queryShape", "fst", "streetMorphology", "spanProposer", "conventionsMask"]) {
			expect(bare.priors.map((p) => p.kind)).toContain(kind)
		}
	})

	it("emissions differ from logits when a prior applies, alias when none do", async () => {
		const tokenizer = await loadTokenizer()
		const text = "12345"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-locality", 0.1)
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const shape = {
			knownFormatHits: [{ format: "us_zip", start: 0, end: 5, confidence: 1.0 }],
		}
		const traced = await classifier.traceParse(text, { queryShape: shape, spanProposer: false })

		expect(traced.priors.find((p) => p.kind === "queryShape")).toEqual({ kind: "queryShape", applied: true })
		expect(traced.emissions).not.toEqual(traced.logits)
	})

	it("carries the locale head + detected system when conventions are on", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-street")
		// LOCALE_COUNTRIES order: US first. A huge US logit clears the 0.8 detection bar.
		const localeLogits = [10, 0, 0, 0, 0, 0, 0, 0, 0]
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits, localeLogits) })

		const trace = await classifier.traceParse(text, { addressSystemConventions: "auto" })

		expect(trace.localeLogits).toEqual(localeLogits)
		expect(trace.systemSource).toBe("auto")
		expect(trace.detectedSystem).toBe("us")

		const off = await classifier.traceParse(text)

		expect(off.systemSource).toBe("off")
		expect(off.detectedSystem).toBeNull()
	})

	it("records repair passes as before/after label sequences", async () => {
		const tokenizer = await loadTokenizer()
		const text = "Main St 90210"
		const { pieces } = tokenizer.encode(text)
		// Everything decodes O; the postcode-repair pass should snap "90210" to a postcode span.
		const logits = pieces.map(() => {
			const row = new Array<number>(STAGE2_BIO_LABELS.length).fill(0)
			row[STAGE2_BIO_LABELS.indexOf("O")] = 2
			return row
		})
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const trace = await classifier.traceParse(text, { postcodeRepair: true, spanProposer: false })
		const repair = trace.repairs.find((r) => r.pass === "postcodeRepair")

		expect(repair).toBeDefined()
		expect(repair!.before).toHaveLength(pieces.length)
		expect(repair!.after).toHaveLength(pieces.length)
		expect(repair!.before).not.toEqual(repair!.after)
		expect(repair!.after.some((label) => label.endsWith("postcode"))).toBe(true)
		// Final tokens reflect the repaired labels.
		expect(trace.tokens.some((t) => t.label.endsWith("postcode"))).toBe(true)
	})

	it("no repairs requested → repairs empty", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-street")
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const trace = await classifier.traceParse(text, { spanProposer: false })

		expect(trace.repairs).toEqual([])
	})

	it("empty input mirrors parse('') — empty trace, no throw", async () => {
		const tokenizer = await loadTokenizer()
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner([]) })

		const trace = await classifier.traceParse("")

		expect(trace.text).toBe("")
		expect(trace.pieces).toEqual([])
		expect(trace.logits).toEqual([])
		expect(trace.tokens).toEqual([])
		expect(trace.repairs).toEqual([])
		expect(trace.caseNormalized).toBe(false)
	})

	it("all-caps input is case-normalized and flagged", async () => {
		const tokenizer = await loadTokenizer()
		const upper = "214 JONES RD"
		// Piece count depends on the normalized text — encode what the model will actually see.
		const { pieces } = tokenizer.encode("214 Jones Rd")
		const logits = logitsWithBoost(pieces.length, 0, "B-house_number")
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const trace = await classifier.traceParse(upper)

		expect(trace.caseNormalized).toBe(true)
		expect(trace.text).not.toBe(upper)
	})

	it("schema snapshot — drift forces a conscious decision", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave 10118"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-house_number")
		const localeLogits = [10, 0, 0, 0, 0, 0, 0, 0, 0]
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits, localeLogits) })

		const trace = await classifier.traceParse(text, { addressSystemConventions: "auto", spanProposer: false })

		await expect(JSON.stringify(trace, null, "\t")).toMatchFileSnapshot("./fixtures/trace-schema.snap.json")
	})
})
```

Notes for the implementer:

- `logitsWithBoost` magnitude 3 (not the 0.3 the query-shape test uses) so decode choices are deterministic against the structural CRF mask.
- If `us_zip` is not a recognized known-format key for the queryShape prior, check `neural/query-shape-prior.ts` for the exact `KnownFormatHitLike` shape and a format string it maps (the test's intent is only "a queryShape prior fires and shifts emissions").
- If the `postcodeRepair` case doesn't fire on `"Main St 90210"`, read `neural/postcode-repair.ts` for a string its US pattern accepts — do not weaken the assertion to pass-without-change.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest --run neural/test/trace-parse.test.ts`
Expected: FAIL — `classifier.traceParse is not a function` (and TS error on the missing `./trace.js` import once added).

- [ ] **Step 3: Create `neural/trace.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parse-trace types — the serializable record of one trip through
 *   `NeuralAddressClassifier`'s decode path: what the model saw (pieces + soft-feature
 *   channels), what it believed (raw logits, locale head), what nudged it (priors), and what
 *   overrode it (repair passes). Produced by `traceParse` (classifier.ts); consumed by the docs
 *   `<ModelVisualizer>` and, later, `mailwoman parse --trace`. Spec:
 *   docs/superpowers/specs/2026-07-03-parse-trace-model-visualizer-design.md.
 *
 *   Everything here is plain JSON-serializable data by construction — no Maps, no classes, no
 *   typed arrays. The schema-snapshot test (test/trace-parse.test.ts) guards drift.
 */

import type { SystemCode } from "@mailwoman/codex"
import type { DecoderToken } from "@mailwoman/core/decoder"

import type { SoftFeatureChannel } from "./soft-features.js"

/** The emission priors the decode path may compose, in application order. */
export type TracePriorKind = "queryShape" | "fst" | "streetMorphology" | "spanProposer" | "conventionsMask"

/** One prior's participation record: present for every kind, `applied` says whether it fired. */
export interface TracePrior {
	kind: TracePriorKind
	applied: boolean
}

/** The post-decode repair passes, in application order. */
export type TraceRepairPass = "wordConsistency" | "postcodeRepair" | "unitRepair" | "spanBridge"

/**
 * A repair pass that changed something: per-piece BIO label sequences before and after, index-aligned
 * with `pieces`. Passes that ran but changed nothing are omitted.
 */
export interface TraceRepair {
	pass: TraceRepairPass
	before: string[]
	after: string[]
}

/** A tokenizer piece as fed to the model — `TokenizedPiece` minus nothing, kept structural for JSON. */
export interface TracePiece {
	piece: string
	id: number
	start: number
	end: number
}

/**
 * The full trace of one `traceParse` call. Field-by-field provenance lives in the spec's trace
 * contract table; the one deviation from that table is that vocab ids ride on `pieces[].id`
 * rather than a parallel `ids` array (same information, one fewer alignment invariant).
 */
export interface NeuralParseTrace {
	/** The text the model actually saw (post case-normalize). */
	text: string
	/** True when case normalization changed the input (`normalizeInputCase`, #690). */
	caseNormalized: boolean
	pieces: TracePiece[]
	/** Postcode-anchor channel exactly as fed (post-choreography). Absent = channel not fed. */
	anchor?: SoftFeatureChannel
	/** Gazetteer channel exactly as fed (post-suppression). Absent = channel not fed. */
	gazetteer?: SoftFeatureChannel
	/** Raw model emissions, pre-prior — `logits[tokenIdx][labelIdx]`. */
	logits: number[][]
	/** Locale-head output (`LOCALE_COUNTRIES` order). Absent on models without the head. */
	localeLogits?: number[]
	/** Address system whose conventions applied, or null when conventions were off / below the bar. */
	detectedSystem: SystemCode | null
	/** How `detectedSystem` was chosen: conventions off, locale-head auto-detect, or caller-pinned. */
	systemSource: "off" | "auto" | "pinned"
	priors: TracePrior[]
	/** The post-prior, post-mask matrix viterbi actually decoded over. Equals `logits` when nothing fired. */
	emissions: number[][]
	/** The label vocabulary, index-aligned with the logits/emissions inner dimension. */
	labels: string[]
	/** Decoded label indices per piece (pre-token-repair; final labels live on `tokens`). */
	path: number[]
	decode: "viterbi" | "argmax"
	repairs: TraceRepair[]
	/** The final tokens — identical to what `parse()` builds its tree from. */
	tokens: DecoderToken[]
}
```

- [ ] **Step 4: Wire trace capture through `#decode` and add `traceParse`**

All edits in `neural/classifier.ts`.

4a. Add imports (alongside the existing import block):

```ts
import type { NeuralParseTrace, TracePrior, TraceRepair, TraceRepairPass } from "./trace.js"
```

4b. Widen `#decode`'s signature and return type. Current signature (line ~348):

```ts
	async #decode(
		text: string,
		opts?: ParseOpts
	): Promise<{
		tokens: DecoderToken[]
		logits: number[][]
		pieces: ReturnType<MailwomanTokenizer["encode"]>["pieces"]
	}> {
```

becomes:

```ts
	async #decode(
		text: string,
		opts?: ParseOpts,
		trace = false
	): Promise<{
		tokens: DecoderToken[]
		logits: number[][]
		pieces: ReturnType<MailwomanTokenizer["encode"]>["pieces"]
		/** Present iff `trace` — the retained intermediates `traceParse` assembles. */
		trace?: {
			anchor?: SoftFeatureChannel
			gazetteer?: SoftFeatureChannel
			localeLogits?: number[]
			detectedSystem: SystemCode | null
			systemSource: "off" | "auto" | "pinned"
			priors: TracePrior[]
			emissions: number[][]
			path: number[]
			repairs: TraceRepair[]
		}
	}> {
```

(`SoftFeatureChannel` needs a type import from `./soft-features.js` if not already present — currently only `buildSoftFeatures` is imported.)

4c. Inside `#decode`, add the accumulators and a repair recorder right after the `buildSoftFeatures` call (`const soft = …`):

```ts
// Trace retention (spec 2026-07-03): capture-by-reference of arrays this method already
// builds. Null when not tracing — the non-trace path allocates nothing new.
const tracePriors: TracePrior[] | null = trace ? [] : null
const traceRepairs: TraceRepair[] | null = trace ? [] : null
const recordRepair = (pass: TraceRepairPass, before: string[], after: string[]): void => {
	if (!traceRepairs) return

	if (before.length === after.length && before.every((label, i) => label === after[i])) return
	traceRepairs.push({ pass, before, after })
}
const labelsOf = (toks: readonly DecoderToken[]): string[] => toks.map((t) => t.label as string)
```

4d. Record each prior where it's applied today. After the `emissions = opts?.queryShape ? … : logits` assignment:

```ts
tracePriors?.push({ kind: "queryShape", applied: Boolean(opts?.queryShape) })
```

After the `if (opts?.fst) { … }` block:

```ts
tracePriors?.push({ kind: "fst", applied: Boolean(opts?.fst) })
```

After the `if (opts?.fstStreetMorphology) { … }` block:

```ts
tracePriors?.push({ kind: "streetMorphology", applied: Boolean(opts?.fstStreetMorphology) })
```

After the `if (spanProposals.length > 0) { … }` block:

```ts
tracePriors?.push({ kind: "spanProposer", applied: spanProposals.length > 0 })
```

Inside the conventions-mask block, the current code guards `if (forbidden.size > 0)`. Record right after that block (note: `forbidden` is scoped inside `if (conventions?.forbiddenTags?.length)`, so capture a flag):

```ts
// current code:
let conventionsMaskApplied = false

if (conventions?.forbiddenTags?.length) {
	const forbidden = new Set<number>()
	// … existing body unchanged …
	if (forbidden.size > 0) {
		conventionsMaskApplied = true
		emissions = emissions.map((row) => row.map((v, idx) => (forbidden.has(idx) ? -1e9 : v)))
	}
}
tracePriors?.push({ kind: "conventionsMask", applied: conventionsMaskApplied })
```

4e. Word-consistency repair operates on `labelIndices` _before_ tokens are built. Wrap the existing block:

```ts
if (opts?.enforceWordConsistency ?? this.cfg.enforceWordConsistency ?? false) {
	const beforeLabels = traceRepairs ? labelIndices.map((i) => (this.labels[i] ?? "O") as string) : []
	const wc = enforceWordConsistency(pieces, emissions, this.labels, labelIndices)
	labelIndices = wc.labelIndices
	healedConfidence = wc.healedConfidence
	recordRepair(
		"wordConsistency",
		beforeLabels,
		labelIndices.map((i) => (this.labels[i] ?? "O") as string)
	)
}
```

4f. The three token-level repair passes each get a before-snapshot. Wrap the existing calls:

```ts
if (opts?.postcodeRepair || conventions?.postcodePattern) {
	const before = traceRepairs ? labelsOf(tokens) : []
	tokens = repairPostcodeLabels(text, tokens).tokens
	recordRepair("postcodeRepair", before, labelsOf(tokens))
}

if (opts?.unitRepair) {
	const before = traceRepairs ? labelsOf(tokens) : []
	tokens = repairUnitLabels(text, tokens).tokens
	recordRepair("unitRepair", before, labelsOf(tokens))
}

if (opts?.bridgePunctuationGaps ?? this.cfg.bridgePunctuationGaps) {
	const blockedSpans = spanProposals.filter((p) => p.kind === "ANNOTATION_SPAN" || p.kind === "QUOTED_SPAN")
	const before = traceRepairs ? labelsOf(tokens) : []
	tokens = bridgePunctuationGaps(text, tokens, blockedSpans.length > 0 ? { blockedSpans } : undefined)
	recordRepair("spanBridge", before, labelsOf(tokens))
}
```

(`recordRepair` no-ops when not tracing and omits unchanged passes — matching the spec's "empty entries omitted".)

4g. The `systemSource` derives from the existing `conventionsOpt` local:

```ts
const systemSource: "off" | "auto" | "pinned" =
	conventionsOpt === undefined ? "off" : conventionsOpt === "auto" ? "auto" : "pinned"
```

Place it next to the existing `detectedSystem` computation.

4h. Widen the final return:

```ts
return {
	tokens,
	logits,
	pieces,
	...(trace
		? {
				trace: {
					...(soft.anchor ? { anchor: soft.anchor } : {}),
					...(soft.gazetteer ? { gazetteer: soft.gazetteer } : {}),
					...(localeLogits ? { localeLogits } : {}),
					detectedSystem,
					systemSource,
					priors: tracePriors!,
					emissions,
					path: labelIndices,
					repairs: traceRepairs!,
				},
			}
		: {}),
}
```

4i. Add `traceParse` directly below `parseWithLogits`:

```ts
	/**
	 * Like `parse`, but returns the full decode-path trace instead of a tree: pieces, soft-feature
	 * channels as fed, raw logits, locale head, prior participation, post-prior emissions, viterbi
	 * path, repair diffs, and the final tokens. Shares the ENTIRE decode path with `parse` (one
	 * `#decode`, #481) and mirrors `parse`'s case normalization, so `buildAddressTree(trace.text,
	 * trace.tokens)` reproduces `parse(text)`'s tree exactly. Serializable by construction — see
	 * `./trace.js` for the schema and the spec reference.
	 */
	async traceParse(text: string, opts?: ParseOpts): Promise<NeuralParseTrace> {
		const labels = [...this.labels] as string[]

		if (text.length === 0) {
			return {
				text,
				caseNormalized: false,
				pieces: [],
				logits: [],
				detectedSystem: null,
				systemSource: "off",
				priors: [],
				emissions: [],
				labels,
				path: [],
				decode: this.decodeMode,
				repairs: [],
				tokens: [],
			}
		}
		const modelText = opts?.normalizeCase !== false ? normalizeInputCase(text) : text
		const { tokens, logits, pieces, trace } = await this.#decode(modelText, opts, true)

		if (!trace) throw new Error("traceParse: #decode returned no trace despite trace=true (invariant)")

		return {
			text: modelText,
			caseNormalized: modelText !== text,
			pieces: pieces.map((p) => ({ piece: p.piece, id: p.id, start: p.start, end: p.end })),
			...(trace.anchor ? { anchor: trace.anchor } : {}),
			...(trace.gazetteer ? { gazetteer: trace.gazetteer } : {}),
			logits,
			...(trace.localeLogits ? { localeLogits: trace.localeLogits } : {}),
			detectedSystem: trace.detectedSystem,
			systemSource: trace.systemSource,
			priors: trace.priors,
			emissions: trace.emissions,
			labels,
			path: trace.path,
			decode: this.decodeMode,
			repairs: trace.repairs,
			tokens: tokens.map((t) => ({ ...t })),
		}
	}
```

4j. Add to `neural/index.ts`, alphabetical with the existing star-exports:

```ts
export * from "./trace.js"
```

- [ ] **Step 5: Run the new test until it passes**

Run: `yarn vitest --run neural/test/trace-parse.test.ts`
Expected: PASS (the snapshot test writes `neural/test/fixtures/trace-schema.snap.json` on first run — inspect it, then re-run to confirm it's stable).

- [ ] **Step 6: Byte-stability — run the whole neural suite**

Run: `yarn vitest --run neural`
Expected: PASS with zero changes to existing test files. Any existing-test failure means the trace capture perturbed the decode path — fix the capture, never the existing test.

- [ ] **Step 7: Commit**

```bash
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git add neural/trace.ts neural/classifier.ts neural/index.ts neural/test/trace-parse.test.ts neural/test/fixtures/trace-schema.snap.json
git -c user.name="Teffen Ellis" -c user.email="teffen@sister.software" commit -m "feat(neural): traceParse — serializable decode-path trace

NeuralParseTrace retains what #decode already computes (pieces, soft
channels as fed, raw logits, locale head, prior participation, post-
prior emissions, viterbi path, repair diffs). Single decode path
preserved (#481); parse/parseWithLogits byte-stable.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Docs trace fixture generated from real weights

**Files:**

- Create: `scripts/generate-trace-fixture.ts`
- Create (generated, committed): `docs/src/components/ModelVisualizer/fixtures/white-house.trace.json`

**Interfaces:**

- Consumes: `NeuralAddressClassifier.loadFromWeights` (`neural/classifier.ts:204`) + `traceParse` from Task 1.
- Produces: the committed fixture JSON that Tasks 3–4's tests and stories import. Regenerating = re-running this script.

- [ ] **Step 1: Write the script**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerate the ModelVisualizer story/test fixture: one real `NeuralParseTrace` from the
 *   locally-resolved en-us weights (`@mailwoman/neural-weights-en-us`). Committed so docs CI
 *   never needs a model download. Re-run after any trace-schema change or weights bump:
 *
 *       node --experimental-strip-types scripts/generate-trace-fixture.ts ["custom address"]
 *
 *   NOTE: on machines without the anchor lookup ($MAILWOMAN_DATA_ROOT), loadFromWeights warns
 *   and the trace's `anchor` channel is absent — the component's "channel not fed" state. The
 *   deployed demo feeds anchor from postcode-<cc>.bin, so regenerate on a lab box for a
 *   fully-fed fixture when that state matters.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { NeuralAddressClassifier } from "@mailwoman/neural"

const here = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(here, "../docs/src/components/ModelVisualizer/fixtures/white-house.trace.json")

const text = process.argv[2] ?? "1600 Pennsylvania Ave NW, Washington, DC 20500"
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-us" })
const trace = await classifier.traceParse(text, { addressSystemConventions: "auto" })

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, `${JSON.stringify(trace, null, "\t")}\n`)
console.log(`wrote ${OUT_PATH} (${trace.pieces.length} pieces, ${trace.labels.length} labels)`)
```

- [ ] **Step 2: Run it and sanity-check the output**

Run: `node --experimental-strip-types scripts/generate-trace-fixture.ts`
Expected: `wrote …/white-house.trace.json (N pieces, 33 labels)`; an anchor-channel warning on this laptop is expected (see script docstring). Then verify:

Run: `node --experimental-strip-types -e 'const t = require("./docs/src/components/ModelVisualizer/fixtures/white-house.trace.json"); console.log(t.tokens.map((x) => x.label).join(" "))'`
Expected: a plausible BIO sequence containing `B-house_number`, `B-street`, `B-locality`, `B-region`, `B-postcode` labels.

- [ ] **Step 3: Commit**

```bash
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git add scripts/generate-trace-fixture.ts docs/src/components/ModelVisualizer/fixtures/white-house.trace.json
git -c user.name="Teffen Ellis" -c user.email="teffen@sister.software" commit -m "feat(docs): committed trace fixture + regeneration script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Docs structural types + pure render helpers

**Files:**

- Modify: `docs/src/shared/resources.tsx` (widen `MailwomanClassifierLike`, add `ParseTraceLike` family at line ~25)
- Create: `docs/src/components/ModelVisualizer/helpers.ts`
- Test: `docs/src/components/ModelVisualizer/helpers.test.ts`

**Interfaces:**

- Consumes: the fixture JSON from Task 2 (shape reference only).
- Produces: `ParseTraceLike`, `TraceChannelLike`, `TraceRepairLike`, `TracePieceLike`, `TraceTokenLike` (resources.tsx); `softmaxRow(row: number[]): number[]`, `matrixAbsMax(m: number[][]): number`, `emissionColor(value: number, absMax: number): string`, `isMasked(value: number): boolean`, `stripBIO(label: string): string`, `pieceDisplay(piece: string): string`, `changedIndices(before: string[], after: string[]): number[]` (helpers.ts). Task 4 imports all of these by these exact names.

- [ ] **Step 1: Widen the docs types**

In `docs/src/shared/resources.tsx`, after the existing `MailwomanClassifierLike` block, add the structural trace types (docs convention: local `*Like` types, no `@mailwoman/neural` imports — the neural-side schema snapshot + committed fixture guard drift):

```ts
export interface TraceChannelLike {
	features: number[][]
	confidence: number[]
}

export interface TracePieceLike {
	piece: string
	id: number
	start: number
	end: number
}

export interface TraceTokenLike {
	piece: string
	start: number
	end: number
	label: string
	confidence: number
}

export interface TraceRepairLike {
	pass: string
	before: string[]
	after: string[]
}

/** Structural mirror of `@mailwoman/neural`'s `NeuralParseTrace` (spec 2026-07-03). */
export interface ParseTraceLike {
	text: string
	caseNormalized: boolean
	pieces: TracePieceLike[]
	anchor?: TraceChannelLike
	gazetteer?: TraceChannelLike
	logits: number[][]
	localeLogits?: number[]
	detectedSystem: string | null
	systemSource: "off" | "auto" | "pinned"
	priors: Array<{ kind: string; applied: boolean }>
	emissions: number[][]
	labels: string[]
	path: number[]
	decode: "viterbi" | "argmax"
	repairs: TraceRepairLike[]
	tokens: TraceTokenLike[]
}
```

and widen `MailwomanClassifierLike`:

```ts
export interface MailwomanClassifierLike {
	parse: (text: string, opts?: { queryShape?: unknown; fst?: FSTMatcherLike }) => Promise<unknown>
	/**
	 * Decode-path introspection (spec 2026-07-03). Optional: deployed bundles built before the
	 * trace seam lack it — feature-detect before calling.
	 */
	traceParse?: (text: string, opts?: { addressSystemConventions?: "auto" }) => Promise<ParseTraceLike>
}
```

- [ ] **Step 2: Write the failing helpers test**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure-function tests for the ModelVisualizer render helpers. Rendering itself is validated
 *   via Storybook (ModelVisualizer.stories.tsx) against the committed fixture.
 */

import { describe, expect, it } from "vitest"

import type { ParseTraceLike } from "../../shared/resources.tsx"
import fixture from "./fixtures/white-house.trace.json"
import { changedIndices, emissionColor, matrixAbsMax, pieceDisplay, softmaxRow, stripBIO } from "./helpers.ts"

describe("ModelVisualizer helpers", () => {
	it("softmaxRow sums to 1 and preserves argmax", () => {
		const probs = softmaxRow([1, 3, 2])
		const sum = probs.reduce((a, b) => a + b, 0)

		expect(sum).toBeCloseTo(1, 6)
		expect(probs[1]).toBeGreaterThan(probs[2]!)
		expect(probs[2]).toBeGreaterThan(probs[0]!)
	})

	it("matrixAbsMax ignores the conventions-mask sentinel", () => {
		expect(
			matrixAbsMax([
				[1, -2],
				[-1e9, 3],
			])
		).toBe(3)
		expect(matrixAbsMax([])).toBe(1)
	})

	it("emissionColor is diverging and clamps", () => {
		expect(emissionColor(0, 5)).toContain("0%")
		expect(emissionColor(5, 5)).not.toBe(emissionColor(-5, 5))
		expect(emissionColor(500, 5)).toBe(emissionColor(5, 5))
	})

	it("stripBIO drops the prefix, keeps O", () => {
		expect(stripBIO("B-house_number")).toBe("house_number")
		expect(stripBIO("I-street")).toBe("street")
		expect(stripBIO("O")).toBe("O")
	})

	it("pieceDisplay swaps the SP space sentinel for a visible marker", () => {
		expect(pieceDisplay("▁Ave")).toBe("␣Ave")
		expect(pieceDisplay("Ave")).toBe("Ave")
	})

	it("changedIndices finds label diffs", () => {
		expect(changedIndices(["O", "O", "O"], ["O", "B-postcode", "I-postcode"])).toEqual([1, 2])
		expect(changedIndices(["O"], ["O"])).toEqual([])
	})

	it("the committed fixture satisfies ParseTraceLike's alignment invariants", () => {
		const trace = fixture as ParseTraceLike

		expect(trace.labels.length).toBeGreaterThan(0)
		expect(trace.logits).toHaveLength(trace.pieces.length)
		expect(trace.emissions).toHaveLength(trace.pieces.length)
		expect(trace.path).toHaveLength(trace.pieces.length)
		expect(trace.tokens).toHaveLength(trace.pieces.length)

		for (const row of trace.logits) expect(row).toHaveLength(trace.labels.length)

		for (const repair of trace.repairs) {
			expect(repair.before).toHaveLength(trace.pieces.length)
			expect(repair.after).toHaveLength(trace.pieces.length)
		}

		if (trace.localeLogits) expect(trace.localeLogits).toHaveLength(9)
	})
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `yarn vitest --run docs/src/components/ModelVisualizer/helpers.test.ts`
Expected: FAIL — `helpers.ts` does not exist. (If vitest doesn't resolve the `.json` import, add `resolveJsonModule` awareness by checking how `docs/src/pages/demo/map-helpers.test.ts` is configured and mirror it; JSON imports are supported by vite/vitest natively.)

- [ ] **Step 4: Implement `helpers.ts`**

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure render helpers for `<ModelVisualizer>` — kept free of React so they unit-test without a
 *   DOM. Color output is CSS `hsl()` strings chosen to read on both light and dark Docusaurus
 *   themes (mid-lightness, alpha-scaled).
 */

/** Conventions-mask sentinel (classifier.ts writes -1e9 ≈ log 0 into masked cells). */
const MASK_SENTINEL_FLOOR = -1e8

/** Numerically-stable softmax over one logit row. */
export function softmaxRow(row: number[]): number[] {
	if (row.length === 0) return []
	const max = Math.max(...row)
	const exps = row.map((v) => Math.exp(v - max))
	const sum = exps.reduce((a, b) => a + b, 0)

	return exps.map((v) => v / sum)
}

/** Largest |value| in a matrix, ignoring mask sentinels. Returns 1 for empty input (safe divisor). */
export function matrixAbsMax(matrix: number[][]): number {
	let max = 0

	for (const row of matrix) {
		for (const v of row) {
			if (v <= MASK_SENTINEL_FLOOR) continue

			const abs = Math.abs(v)

			if (abs > max) max = abs
		}
	}

	return max === 0 ? 1 : max
}

/** True when a cell was removed from the vocabulary by the conventions mask. */
export function isMasked(value: number): boolean {
	return value <= MASK_SENTINEL_FLOOR
}

/**
 * Diverging heat color: positive → teal, negative → orange, 0 → transparent. `value` is clamped
 * to ±absMax; intensity rides the alpha channel so the cell text stays legible.
 */
export function emissionColor(value: number, absMax: number): string {
	const t = Math.max(-1, Math.min(1, value / absMax))
	const alpha = Math.abs(t) * 0.85

	return t >= 0 ? `hsl(174 60% 40% / ${(alpha * 100).toFixed(0)}%)` : `hsl(24 85% 50% / ${(alpha * 100).toFixed(0)}%)`
}

/** `B-street` → `street`, `I-street` → `street`, `O` → `O`. */
export function stripBIO(label: string): string {
	return label.replace(/^[BI]-/, "")
}

/** Replace the SentencePiece space sentinel (`▁`, U+2581) with a visible open-box marker. */
export function pieceDisplay(piece: string): string {
	return piece.replace(/▁/g, "␣")
}

/** Indices where two index-aligned label sequences disagree. */
export function changedIndices(before: string[], after: string[]): number[] {
	const out: number[] = []
	const len = Math.max(before.length, after.length)

	for (let i = 0; i < len; i++) {
		if (before[i] !== after[i]) out.push(i)
	}

	return out
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `yarn vitest --run docs/src/components/ModelVisualizer/helpers.test.ts`
Expected: PASS. Also run `yarn workspace @mailwoman/docs typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git add docs/src/shared/resources.tsx docs/src/components/ModelVisualizer/helpers.ts docs/src/components/ModelVisualizer/helpers.test.ts
git -c user.name="Teffen Ellis" -c user.email="teffen@sister.software" commit -m "feat(docs): ParseTraceLike types + ModelVisualizer render helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `<ModelVisualizer>` pure component + story

**Files:**

- Create: `docs/src/components/ModelVisualizer/ModelVisualizer.tsx`
- Create: `docs/src/components/ModelVisualizer/styles.module.css`
- Create: `docs/src/components/ModelVisualizer/ModelVisualizer.stories.tsx`

**Interfaces:**

- Consumes: `ParseTraceLike` (Task 3), all six helpers (Task 3), fixture JSON (Task 2).
- Produces: `export function ModelVisualizer(props: { trace: ParseTraceLike }): JSX.Element`. Task 5's live wrapper renders it.

- [ ] **Step 1: Implement the component**

Four bands + gauge, one shared piece-per-column x-axis. Pure — no context, no fetches.

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   <ModelVisualizer trace={…}> — renders one `ParseTraceLike` (the serializable record of a trip
 *   through the neural decode path) as four piece-aligned bands + a locale gauge:
 *
 *   1. Token ribbon — the SentencePiece pieces with char offsets.
 *   2. Channel band — anchor/gazetteer confidence as fed ("not fed" when a channel is absent —
 *      an unfed channel is a diagnostic fact, the #566/#685 OOD class, not an empty one).
 *   3. Emissions heatmap — labels × pieces; toggle raw logits vs post-prior emissions (the delta
 *      IS the priors' influence); conventions-masked cells hatched; viterbi path outlined.
 *   4. Decode band — final tokens, confidence bars, repair-pass diffs as before→after chips.
 *
 *   Pure and fixture-drivable; the live wrapper (LiveModelVisualizer) feeds it from
 *   `useDemoEmbed()`. Spec: docs/superpowers/specs/2026-07-03-parse-trace-model-visualizer-design.md.
 */

import React, { useMemo, useState } from "react"

import type { ParseTraceLike } from "../../shared/resources.tsx"
import { changedIndices, emissionColor, isMasked, matrixAbsMax, pieceDisplay, softmaxRow, stripBIO } from "./helpers.ts"
import styles from "./styles.module.css"

const LOCALE_ORDER = ["US", "FR", "DE", "CA", "GB", "JP", "ES", "IT", "NL"] as const

export interface ModelVisualizerProps {
	trace: ParseTraceLike
}

export function ModelVisualizer({ trace }: ModelVisualizerProps): JSX.Element {
	const [matrixMode, setMatrixMode] = useState<"logits" | "emissions">("emissions")
	const matrix = matrixMode === "logits" ? trace.logits : trace.emissions
	const absMax = useMemo(() => matrixAbsMax(matrix), [matrix])
	const localeProbs = useMemo(() => (trace.localeLogits ? softmaxRow(trace.localeLogits) : null), [trace.localeLogits])

	if (trace.pieces.length === 0) {
		return <div className={styles.empty}>Empty input — nothing to trace.</div>
	}

	return (
		<div className={styles.root}>
			<header className={styles.header}>
				<code className={styles.inputText}>{trace.text}</code>
				<span className={styles.chips}>
					{trace.caseNormalized ? <span className={styles.chip}>case-normalized</span> : null}
					<span className={styles.chip}>
						system: {trace.detectedSystem ?? "none"} ({trace.systemSource})
					</span>
					<span className={styles.chip}>decode: {trace.decode}</span>
				</span>
			</header>

			<section aria-label="Token ribbon">
				<h4 className={styles.bandTitle}>1 · Tokens</h4>
				<div className={styles.ribbon}>
					{trace.pieces.map((p, i) => (
						<span key={i} className={styles.piece} title={`id ${p.id} · chars [${p.start}, ${p.end})`}>
							{pieceDisplay(p.piece)}
						</span>
					))}
				</div>
			</section>

			<section aria-label="Retrieval channels">
				<h4 className={styles.bandTitle}>2 · Retrieval channels</h4>
				<ChannelRow name="anchor" channel={trace.anchor} count={trace.pieces.length} />
				<ChannelRow name="gazetteer" channel={trace.gazetteer} count={trace.pieces.length} />
			</section>

			<section aria-label="Emissions heatmap">
				<h4 className={styles.bandTitle}>
					3 · Emissions
					<button
						type="button"
						className={styles.toggle}
						onClick={() => setMatrixMode((m) => (m === "logits" ? "emissions" : "logits"))}
					>
						{matrixMode === "emissions" ? "post-prior (click for raw)" : "raw logits (click for post-prior)"}
					</button>
				</h4>
				<div className={styles.heatmapScroll}>
					<table className={styles.heatmap}>
						<tbody>
							{trace.labels.map((label, li) => (
								<tr key={label}>
									<th className={styles.labelCell}>{label}</th>
									{trace.pieces.map((_, ti) => {
										const value = matrix[ti]?.[li] ?? 0
										const onPath = trace.path[ti] === li

										return (
											<td
												key={ti}
												className={[
													styles.cell,
													onPath ? styles.pathCell : "",
													isMasked(value) ? styles.maskedCell : "",
												].join(" ")}
												style={isMasked(value) ? undefined : { backgroundColor: emissionColor(value, absMax) }}
												title={`${label} × ${pieceDisplay(trace.pieces[ti]!.piece)}: ${isMasked(value) ? "masked" : value.toFixed(3)}`}
											/>
										)
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className={styles.priorLine}>
					Priors: {trace.priors.map((p) => `${p.kind}${p.applied ? " ✓" : " –"}`).join("  ")}
				</p>
			</section>

			<section aria-label="Decode">
				<h4 className={styles.bandTitle}>4 · Decode</h4>
				<div className={styles.ribbon}>
					{trace.tokens.map((t, i) => (
						<span key={i} className={styles.decoded} data-o={t.label === "O" || undefined} title={t.label}>
							<span className={styles.decodedPiece}>{pieceDisplay(t.piece)}</span>
							<span className={styles.decodedLabel}>{stripBIO(t.label)}</span>
							<span className={styles.confidenceBar} style={{ width: `${(t.confidence * 100).toFixed(0)}%` }} />
						</span>
					))}
				</div>
				{trace.repairs.map((repair) => (
					<p key={repair.pass} className={styles.repairLine}>
						<strong>{repair.pass}</strong>
						{": "}
						{changedIndices(repair.before, repair.after)
							.map(
								(i) =>
									`${pieceDisplay(trace.pieces[i]?.piece ?? `#${i}`)} ${stripBIO(repair.before[i] ?? "?")}→${stripBIO(repair.after[i] ?? "?")}`
							)
							.join(", ")}
					</p>
				))}
			</section>

			{localeProbs ? (
				<section aria-label="Locale head">
					<h4 className={styles.bandTitle}>Locale head</h4>
					<div className={styles.gauge}>
						{LOCALE_ORDER.map((cc, i) => (
							<div key={cc} className={styles.gaugeCol} title={`${cc}: ${((localeProbs[i] ?? 0) * 100).toFixed(1)}%`}>
								<div className={styles.gaugeBar} style={{ height: `${((localeProbs[i] ?? 0) * 100).toFixed(1)}%` }} />
								<span className={styles.gaugeLabel}>{cc}</span>
							</div>
						))}
					</div>
				</section>
			) : null}
		</div>
	)
}

function ChannelRow({
	name,
	channel,
	count,
}: {
	name: string
	channel: ParseTraceLike["anchor"]
	count: number
}): JSX.Element {
	if (!channel) {
		return (
			<div className={styles.channelRow}>
				<span className={styles.channelName}>{name}</span>
				<span className={styles.notFed}>not fed</span>
			</div>
		)
	}

	return (
		<div className={styles.channelRow}>
			<span className={styles.channelName}>{name}</span>
			{Array.from({ length: count }, (_, i) => (
				<span
					key={i}
					className={styles.channelCell}
					style={{ opacity: Math.max(0.06, channel.confidence[i] ?? 0) }}
					title={`confidence ${(channel.confidence[i] ?? 0).toFixed(2)} · features [${(channel.features[i] ?? []).map((v) => v.toFixed(2)).join(", ")}]`}
				/>
			))}
		</div>
	)
}
```

- [ ] **Step 2: Styles**

`styles.module.css` (uses Docusaurus theme variables so both color modes work):

```css
.root {
	display: flex;
	flex-direction: column;
	gap: 1rem;
	font-size: 0.85rem;
}

.header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
}

.inputText {
	font-size: 1rem;
}

.chips {
	display: inline-flex;
	gap: 0.35rem;
}

.chip {
	border: 1px solid var(--ifm-color-emphasis-300);
	border-radius: 999px;
	padding: 0.05rem 0.55rem;
	font-size: 0.72rem;
	color: var(--ifm-color-emphasis-700);
}

.bandTitle {
	margin: 0 0 0.35rem;
	display: flex;
	align-items: baseline;
	gap: 0.75rem;
}

.toggle {
	font-size: 0.72rem;
	cursor: pointer;
	background: none;
	border: 1px solid var(--ifm-color-emphasis-300);
	border-radius: 4px;
	color: var(--ifm-color-emphasis-700);
}

.ribbon {
	display: flex;
	flex-wrap: wrap;
	gap: 0.25rem;
}

.piece {
	font-family: var(--ifm-font-family-monospace);
	border: 1px solid var(--ifm-color-emphasis-300);
	border-radius: 4px;
	padding: 0.1rem 0.35rem;
}

.channelRow {
	display: flex;
	align-items: center;
	gap: 2px;
	margin-bottom: 2px;
}

.channelName {
	width: 5.5rem;
	font-size: 0.72rem;
	color: var(--ifm-color-emphasis-600);
}

.channelCell {
	width: 1.1rem;
	height: 0.8rem;
	border-radius: 2px;
	background: var(--ifm-color-primary);
}

.notFed {
	font-size: 0.72rem;
	font-style: italic;
	color: var(--ifm-color-emphasis-500);
}

.heatmapScroll {
	overflow-x: auto;
}

.heatmap {
	border-collapse: collapse;
	table-layout: fixed;
}

.labelCell {
	font-size: 0.65rem;
	font-weight: 400;
	text-align: right;
	padding-right: 0.4rem;
	white-space: nowrap;
	color: var(--ifm-color-emphasis-600);
}

.cell {
	width: 1.1rem;
	min-width: 1.1rem;
	height: 0.75rem;
	border: 1px solid var(--ifm-color-emphasis-200);
	padding: 0;
}

.pathCell {
	outline: 2px solid var(--ifm-color-primary-darkest);
	outline-offset: -2px;
}

.maskedCell {
	background: repeating-linear-gradient(
		45deg,
		transparent,
		transparent 2px,
		var(--ifm-color-emphasis-300) 2px,
		var(--ifm-color-emphasis-300) 3px
	);
}

.priorLine,
.repairLine {
	margin: 0.35rem 0 0;
	font-size: 0.72rem;
	color: var(--ifm-color-emphasis-700);
}

.decoded {
	position: relative;
	display: inline-flex;
	flex-direction: column;
	border: 1px solid var(--ifm-color-emphasis-300);
	border-radius: 4px;
	padding: 0.1rem 0.35rem 0.25rem;
	overflow: hidden;
}

.decoded[data-o] {
	opacity: 0.55;
}

.decodedPiece {
	font-family: var(--ifm-font-family-monospace);
}

.decodedLabel {
	font-size: 0.62rem;
	color: var(--ifm-color-primary-darkest);
}

.confidenceBar {
	position: absolute;
	bottom: 0;
	left: 0;
	height: 3px;
	background: var(--ifm-color-primary);
}

.gauge {
	display: flex;
	gap: 0.5rem;
	align-items: flex-end;
	height: 5rem;
}

.gaugeCol {
	display: flex;
	flex-direction: column;
	justify-content: flex-end;
	align-items: center;
	height: 100%;
	width: 2rem;
}

.gaugeBar {
	width: 100%;
	background: var(--ifm-color-primary);
	border-radius: 2px 2px 0 0;
}

.gaugeLabel {
	font-size: 0.65rem;
}

.empty {
	font-style: italic;
	color: var(--ifm-color-emphasis-500);
}
```

- [ ] **Step 3: Story**

`ModelVisualizer.stories.tsx` (mirrors `SpanHighlight.stories.tsx`'s format):

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import type { ParseTraceLike } from "../../shared/resources.tsx"
import fixture from "./fixtures/white-house.trace.json"
import { ModelVisualizer } from "./ModelVisualizer.tsx"

const meta = {
	title: "Demo/ModelVisualizer",
	component: ModelVisualizer,
	tags: ["autodocs"],
} satisfies Meta<typeof ModelVisualizer>

export default meta

type Story = StoryObj<typeof meta>

export const WhiteHouse: Story = {
	args: { trace: fixture as ParseTraceLike },
}

export const EmptyInput: Story = {
	args: {
		trace: {
			text: "",
			caseNormalized: false,
			pieces: [],
			logits: [],
			detectedSystem: null,
			systemSource: "off",
			priors: [],
			emissions: [],
			labels: [],
			path: [],
			decode: "viterbi",
			repairs: [],
			tokens: [],
		},
	},
}
```

- [ ] **Step 4: Verify**

Run: `yarn workspace @mailwoman/docs typecheck`
Expected: clean.

Then smoke the story visually — use the **run-docs skill** (docs-scoped) or directly: `yarn workspace @mailwoman/docs storybook`, open `Demo/ModelVisualizer` → WhiteHouse. Expected: four bands render, heatmap toggle flips raw/post-prior, gazetteer channel shows heat, anchor row says "not fed" (this laptop's fixture), locale gauge shows a dominant US bar.

- [ ] **Step 5: Commit**

```bash
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git add docs/src/components/ModelVisualizer/
git -c user.name="Teffen Ellis" -c user.email="teffen@sister.software" commit -m "feat(docs): ModelVisualizer — four-band trace renderer + story

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Live wrapper + site page

**Files:**

- Create: `docs/src/components/ModelVisualizer/LiveModelVisualizer.tsx`
- Create: `docs/src/pages/trace.tsx`

**Interfaces:**

- Consumes: `useDemoEmbed()` (`docs/src/contexts/DemoEmbed.tsx:81` — `{ classifier, ready, loadingProgress }`), `DemoEmbedProvider` (needs `sqljsBaseURL="/mailwoman/sqljs"`), `ModelVisualizer` (Task 4), `MailwomanClassifierLike.traceParse` (Task 3).
- Produces: the `/trace` page. Nothing downstream depends on it in this plan.

- [ ] **Step 1: Implement `LiveModelVisualizer.tsx`**

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Live wrapper for <ModelVisualizer>: an input box + the demo-embed classifier (production
 *   Hugging Face assets via DemoEmbedProvider). Feature-detects `traceParse` — deployed bundles
 *   built before the trace seam lack it, in which case we say so instead of crashing.
 */

import React, { useCallback, useState } from "react"

import { useDemoEmbed } from "../../contexts/DemoEmbed.tsx"
import type { ParseTraceLike } from "../../shared/resources.tsx"
import { ModelVisualizer } from "./ModelVisualizer.tsx"
import styles from "./styles.module.css"

const DEFAULT_TEXT = "1600 Pennsylvania Ave NW, Washington, DC 20500"

export function LiveModelVisualizer(): JSX.Element {
	const { classifier, ready, loadingProgress } = useDemoEmbed()
	const [text, setText] = useState(DEFAULT_TEXT)
	const [trace, setTrace] = useState<ParseTraceLike | null>(null)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const run = useCallback(async () => {
		if (!classifier?.traceParse) return
		setPending(true)
		setError(null)

		try {
			setTrace(await classifier.traceParse(text, { addressSystemConventions: "auto" }))
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setPending(false)
		}
	}, [classifier, text])

	if (!ready) return <p>Loading model assets… {loadingProgress ?? ""}</p>

	if (!classifier?.traceParse) {
		return <p>This deployed model bundle predates the trace seam — trace introspection unavailable.</p>
	}

	return (
		<div className={styles.root}>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void run()
				}}
			>
				<input
					type="text"
					value={text}
					onChange={(e) => setText(e.target.value)}
					size={60}
					aria-label="Address to trace"
				/>
				<button type="submit" disabled={pending}>
					{pending ? "Tracing…" : "Trace"}
				</button>
			</form>
			{error ? <p role="alert">{error}</p> : null}
			{trace ? <ModelVisualizer trace={trace} /> : null}
		</div>
	)
}
```

Implementation notes:

- Check `DemoEmbedState`'s exact field names in `docs/src/contexts/DemoEmbed.tsx` before wiring (`loadingProgress` may be structured, not a string) — adjust the loading line to whatever the context actually exposes (the GuidedTour usage at `docs/src/components/GuidedTour/GuidedTour.tsx:102` is the reference consumer).
- `useDemoEmbed().classifier` is typed `MailwomanClassifierLike | null` — the optional `traceParse` added in Task 3 makes the feature-detect type-check.

- [ ] **Step 2: Implement the page**

`docs/src/pages/trace.tsx` — mirror the provider usage documented in `PipelineExplorer.tsx:14-20` and the page scaffolding of `docs/src/pages/demo/index.tsx` (check its `Layout` usage before writing):

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   /trace — follow an address through the neural decode path. Loads the same production model
 *   assets as /demo (DemoEmbedProvider) and renders the four-band ModelVisualizer live.
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import Layout from "@theme/Layout"
import React from "react"

export default function TracePage(): JSX.Element {
	return (
		<Layout title="Trace" description="Follow an address through the mailwoman neural decode path">
			<main style={{ padding: "2rem", maxWidth: 1100, margin: "0 auto" }}>
				<h1>Trace a parse</h1>
				<p>
					Type an address and watch it move through the model: tokens, retrieval channels, emissions, and the decoded
					result — including every prior and repair pass that shaped it.
				</p>
				<BrowserOnly fallback={<p>Loading…</p>}>
					{() => {
						const { DemoEmbedProvider } = require("../contexts/DemoEmbed.tsx")
						const { LiveModelVisualizer } = require("../components/ModelVisualizer/LiveModelVisualizer.tsx")

						return (
							<DemoEmbedProvider sqljsBaseURL="/mailwoman/sqljs">
								<LiveModelVisualizer />
							</DemoEmbedProvider>
						)
					}}
				</BrowserOnly>
			</main>
		</Layout>
	)
}
```

(If other docs pages import the provider statically rather than via `require` inside `BrowserOnly`, follow the house pattern — check how `docs/src/pages/demo/index.tsx` handles browser-only modules and mirror it.)

- [ ] **Step 3: Verify in the running site**

Use the **run-docs skill** to start the docs site, then open `http://localhost:7770/trace`. Expected: asset loading indicator → input box → clicking Trace renders the four bands from a live parse. ⚠ The deployed HF bundle's `@mailwoman/neural` code is bundled from _local source_ (webpack alias), so `traceParse` exists at runtime; only the model/tokenizer bytes come from production.

Run: `yarn workspace @mailwoman/docs typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git add docs/src/components/ModelVisualizer/LiveModelVisualizer.tsx docs/src/pages/trace.tsx
git -c user.name="Teffen Ellis" -c user.email="teffen@sister.software" commit -m "feat(docs): /trace page — live ModelVisualizer on production assets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Full verification sweep

**Files:** none (verification only; fixes fold back into the owning task's files).

**Interfaces:** n/a.

- [ ] **Step 1: Neural suite (byte-stability + new tests)**

Run: `yarn vitest --run neural`
Expected: PASS, including `trace-parse.test.ts`.

- [ ] **Step 2: Docs tests + typecheck**

Run: `yarn vitest --run docs/src/components/ModelVisualizer && yarn workspace @mailwoman/docs typecheck`
Expected: PASS / clean.

- [ ] **Step 3: Repo lint/format gates**

Run: `yarn lint:oxlint && yarn lint:oxfmt` (skip `lint:python` — no Python touched). If oxfmt flags the new files, run `yarn format` and re-check. Fix violations in the files this plan touched only.

- [ ] **Step 4: Docs production build smoke**

Use the **run-docs skill**'s build/smoke flow (or `yarn workspace @mailwoman/docs build`). Expected: build succeeds; `/trace` present in the output.

- [ ] **Step 5: Final commit (only if gates required fixes)**

```bash
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git add -u
git -c user.name="Teffen Ellis" -c user.email="teffen@sister.software" commit -m "chore: lint/format fixes for parse-trace work

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deferred to the next plan (spec increments 3–4)

- `mailwoman parse --trace json|mermaid` + `runPipeline` trace threading + the `ParseTrace` envelope type.
- Resolver stage payload (`resolve` key reserved in the envelope).
- Marketing polish on the component (animation, guided narrative).
