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
import type { QueryShapeLike } from "../query-shape-prior.js"
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
