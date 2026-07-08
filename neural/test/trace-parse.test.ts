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

import { buildAddressTree } from "@mailwoman/core/decoder"
import { repoRootPathBuilder } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import type { AnchorLookup } from "../anchor-inference.js"
import { NeuralAddressClassifier, type NeuralRunner } from "../classifier.js"
import { STAGE2_BIO_LABELS } from "../labels.js"
import type { InferResult } from "../onnx-runner.js"
import type { QueryShapeLike } from "../query-shape-prior.js"
import { MailwomanTokenizer } from "../tokenizer.js"
import { TRACE_PRIOR_KINDS } from "../trace.js"

const TOKENIZER_PATH = String(repoRootPathBuilder("neural", "test", "fixtures", "tokenizer-v0.1.0.model"))

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

		if (t === boostIdx && labelIdx >= 0) {
			row[labelIdx] = magnitude
		}
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

		// The span proposer is default-ON; whether it fires depends on the text. The contract is
		// EVERY kind, in application order — asserted against the exported constant, so a new prior
		// added to #decode without its participation record fails here instead of silently vanishing
		// from traces.
		expect(bare.priors.map((p) => p.kind)).toEqual([...TRACE_PRIOR_KINDS])
	})

	it("emissions differ from logits when a prior applies, match when none do", async () => {
		const tokenizer = await loadTokenizer()
		const text = "12345"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-locality", 0.1)
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 1.0 }],
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
		// A GB alphanumeric postcode: the repair pass's ADD path creates a span over all-O labels
		// (numeric shapes like a bare ZIP are SNAP-only and never fire from all-O — see
		// postcode-repair.ts precision guards).
		const text = "London SW1A 1AA"
		const { pieces } = tokenizer.encode(text)
		// Everything decodes O; the postcode-repair pass should add the "SW1A 1AA" postcode span.
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

	it("spanBridge repair stays piece-aligned even though the bridge MERGES tokens", async () => {
		const tokenizer = await loadTokenizer()
		// "P.O. Box" fragments: label the alphanumeric pieces street (a STAGE2 tag — the fake
		// classifier runs the 21-label set, and the bridge is tag-agnostic), leave the dot pieces O.
		// The bridge merges the fragments across the unlabeled intra-token punctuation, DROPPING
		// tokens; the trace contract still promises per-piece before/after (char-offset projection).
		const text = "P.O. Box 123"
		const { pieces } = tokenizer.encode(text)
		const oIdx = STAGE2_BIO_LABELS.indexOf("O")
		const bIdx = STAGE2_BIO_LABELS.indexOf("B-street")
		const iIdx = STAGE2_BIO_LABELS.indexOf("I-street")
		// Each fragment STARTS with B- (O → I- is an illegal BIO transition the viterbi mask forbids);
		// only a contiguous continuation piece gets I-. The dots decode O — the gaps the bridge crosses.
		const logits = pieces.map((p, idx) => {
			const row = new Array<number>(STAGE2_BIO_LABELS.length).fill(0)
			const alnum = /[\p{L}\p{N}]/u.test(p.piece)
			const prev = pieces[idx - 1]
			const continues = alnum && prev !== undefined && /[\p{L}\p{N}]/u.test(prev.piece) && prev.end === p.start

			row[alnum ? (continues ? iIdx : bIdx) : oIdx] = 4

			return row
		})
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const trace = await classifier.traceParse(text, { bridgePunctuationGaps: true, spanProposer: false })
		const bridge = trace.repairs.find((r) => r.pass === "spanBridge")

		// The bridge must have merged (fewer final tokens than pieces) — otherwise this test's
		// premise is dead and it should fail loudly rather than assert nothing.
		expect(trace.tokens.length).toBeLessThan(pieces.length)
		expect(bridge).toBeDefined()
		expect(bridge!.before).toHaveLength(pieces.length)
		expect(bridge!.after).toHaveLength(pieces.length)
		// The merged span's label covers the punctuation pieces it absorbed.
		expect(bridge!.after.filter((l) => l.endsWith("street")).length).toBeGreaterThan(
			bridge!.before.filter((l) => l.endsWith("street")).length
		)
	})

	it("anchor channel rides the trace exactly as fed, piece-aligned", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave 10118"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-house_number")
		const anchor: AnchorLookup = new Map([["10118", { posterior: { US: 1 }, lat: 40.75, lon: -73.99 }]])
		const classifier = new NeuralAddressClassifier({
			tokenizer,
			runner: new FakeRunner(logits),
			postcodeAnchorLookup: anchor,
		})

		const trace = await classifier.traceParse(text, { spanProposer: false })

		expect(trace.anchor).toBeDefined()
		expect(trace.anchor!.confidence).toHaveLength(pieces.length)
		expect(trace.anchor!.features).toHaveLength(pieces.length)
		// The ZIP's pieces carry the anchor hit; leading pieces don't.
		expect(Math.max(...trace.anchor!.confidence)).toBeGreaterThan(0)
		// Serializable by construction: a JSON round-trip preserves the channel byte-for-byte.
		expect(JSON.parse(JSON.stringify(trace.anchor))).toEqual(trace.anchor)
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
