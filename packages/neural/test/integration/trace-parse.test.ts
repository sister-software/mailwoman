import { buildAddressTree } from "@mailwoman/core/decoder"
import { prettyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import type { AnchorLookup } from "@mailwoman/neural/anchor-inference"
import { NeuralAddressClassifier, type NeuralRunner } from "@mailwoman/neural/classifier"
import { STAGE2_BIO_LABELS } from "@mailwoman/neural/labels"
import type { InferResult } from "@mailwoman/neural/onnx-runner"
import type { QueryShapeLike } from "@mailwoman/neural/query-shape-prior"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { TRACE_PRIOR_KINDS } from "@mailwoman/neural/trace"
import { describe, expect, it } from "vitest"

const TOKENIZER_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

class FakeRunner implements NeuralRunner {
	readonly #canned: number[][]
	readonly #localeLogits?: number[]

	constructor(canned: number[][], localeLogits?: number[]) {
		this.#canned = canned
		this.#localeLogits = localeLogits
	}
	async infer(_ids: number[]): Promise<InferResult> {
		return {
			logits: this.#canned,
			numLabels: this.#canned[0]?.length ?? 0,
			...(this.#localeLogits ? { localeLogits: this.#localeLogits } : {}),
		}
	}
}

function logitsWithBoost(numTokens: number, boostIdx: number, boostLabel: string, magnitude = 3): number[][] {
	const labelIdx = STAGE2_BIO_LABELS.indexOf(boostLabel as (typeof STAGE2_BIO_LABELS)[number])
	const matrix: number[][] = []

	for (let t = 0; t < numTokens; t++) {
		const row = Array.from<number>({ length: STAGE2_BIO_LABELS.length }).fill(0)

		if (t === boostIdx && labelIdx !== -1) {
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

		expect(bare.priors.map((p) => p.kind)).toEqual([...TRACE_PRIOR_KINDS])
	})

	it("placetypePair record carries probePath naming the probe-chain leg (segment vs anchored), absent when inert", async () => {
		const tokenizer = await loadTokenizer()

		const index = {
			delta: 6,
			probe: (child: string, parent: string) =>
				child === "moelfre" && parent === "abergele"
					? ({ tag: "dependent_locality", parentTag: "locality" } as const)
					: undefined,
		}

		const commaText = "Moelfre, Abergele"
		const { pieces: commaPieces } = tokenizer.encode(commaText)

		const commaClassifier = new NeuralAddressClassifier({
			tokenizer,
			runner: new FakeRunner(logitsWithBoost(commaPieces.length, 0, "B-street")),
		})

		const commaTrace = await commaClassifier.traceParse(commaText, {
			placetypePair: { index },
			spanProposer: false,
		})

		expect(commaTrace.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: true,
			probePath: "segment",
		})

		const bareText = "Moelfre Abergele"
		const { pieces: barePieces } = tokenizer.encode(bareText)

		const bareClassifier = new NeuralAddressClassifier({
			tokenizer,
			runner: new FakeRunner(logitsWithBoost(barePieces.length, 0, "B-street")),
		})

		const bareTrace = await bareClassifier.traceParse(bareText, {
			placetypePair: { index },
			spanProposer: false,
		})

		expect(bareTrace.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: true,
			probePath: "anchored",
		})

		const inertTrace = await bareClassifier.traceParse(bareText, { spanProposer: false })

		expect(inertTrace.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: false,
		})
	})

	it("emissions differ from logits when a prior applies, match when none do", async () => {
		const tokenizer = await loadTokenizer()
		const text = "12345"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-locality", 0.1)
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const shape: QueryShapeLike = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 1 }],
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

		const text = "London SW1A 1AA"
		const { pieces } = tokenizer.encode(text)

		const logits = pieces.map(() => {
			const row = Array.from<number>({ length: STAGE2_BIO_LABELS.length }).fill(0)
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

		expect(trace.tokens.some((t) => t.label.endsWith("postcode"))).toBe(true)
	})

	it("GB conventions pin : a clipped GB postcode is snap-repaired with NO explicit postcodeRepair opt", async () => {
		const tokenizer = await loadTokenizer()
		const text = "Macclesfield SK11 9PD"
		const { pieces } = tokenizer.encode(text)
		const postcodeStart = text.indexOf("SK11")

		const firstPostcodePiece = pieces.findIndex((p) => p.start >= postcodeStart && p.end > p.start)
		expect(firstPostcodePiece).toBeGreaterThan(0)

		const logits = pieces.map((_, i) => {
			const row = Array.from<number>({ length: STAGE2_BIO_LABELS.length }).fill(0)

			const label =
				i < firstPostcodePiece
					? i === 0
						? "B-locality"
						: "I-locality"
					: i === firstPostcodePiece
						? "B-region"
						: i === firstPostcodePiece + 1
							? "B-postcode"
							: "I-postcode"

			row[STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])] = 6

			return row
		})

		const unpinned = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })
		const clippedTrace = await unpinned.traceParse(text, { spanProposer: false })

		expect(clippedTrace.repairs.filter((r) => r.pass === "postcodeRepair")).toEqual([])
		const clipped = (await unpinned.parseJSON(text)) as { postcode?: string }
		expect(clipped.postcode).toBeDefined()
		expect(clipped.postcode).not.toBe("SK11 9PD")
		expect("SK11 9PD".endsWith(clipped.postcode!)).toBe(true)

		const pinned = new NeuralAddressClassifier({
			tokenizer,
			runner: new FakeRunner(logits),
			addressSystemConventions: "gb",
		})

		const trace = await pinned.traceParse(text, { spanProposer: false })
		expect(trace.systemSource).toBe("pinned")
		expect(trace.detectedSystem).toBe("gb")
		const repair = trace.repairs.find((r) => r.pass === "postcodeRepair")
		expect(repair).toBeDefined()
		expect(repair!.before).not.toEqual(repair!.after)

		const repaired = (await pinned.parseJSON(text)) as { postcode?: string; region?: string }
		expect(repaired.postcode).toBe("SK11 9PD")
		expect(repaired.region).toBeUndefined()
	})

	it("No repairs requested → repairs empty", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-street")
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const trace = await classifier.traceParse(text, { spanProposer: false })

		expect(trace.repairs).toEqual([])
	})

	it("Empty input mirrors parse('') — empty trace without throwing", async () => {
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

		const { pieces } = tokenizer.encode("214 Jones Rd")
		const logits = logitsWithBoost(pieces.length, 0, "B-house_number")
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const trace = await classifier.traceParse(upper)

		expect(trace.caseNormalized).toBe(true)
		expect(trace.text).not.toBe(upper)
	})

	it("spanBridge repair stays piece-aligned even though the bridge MERGES tokens", async () => {
		const tokenizer = await loadTokenizer()

		const text = "P.O. Box 123"
		const { pieces } = tokenizer.encode(text)
		const oIdx = STAGE2_BIO_LABELS.indexOf("O")
		const bIdx = STAGE2_BIO_LABELS.indexOf("B-street")
		const iIdx = STAGE2_BIO_LABELS.indexOf("I-street")

		const logits = pieces.map((p, idx) => {
			const row = Array.from<number>({ length: STAGE2_BIO_LABELS.length }).fill(0)
			const alnum = /[\p{L}\p{N}]/u.test(p.piece)
			const prev = pieces[idx - 1]
			const continues = alnum && prev !== undefined && /[\p{L}\p{N}]/u.test(prev.piece) && prev.end === p.start

			row[alnum ? (continues ? iIdx : bIdx) : oIdx] = 4

			return row
		})

		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })

		const trace = await classifier.traceParse(text, { bridgePunctuationGaps: true, spanProposer: false })
		const bridge = trace.repairs.find((r) => r.pass === "spanBridge")

		expect(trace.tokens.length).toBeLessThan(pieces.length)
		expect(bridge).toBeDefined()
		expect(bridge!.before).toHaveLength(pieces.length)
		expect(bridge!.after).toHaveLength(pieces.length)

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

		expect(Math.max(...trace.anchor!.confidence)).toBeGreaterThan(0)

		expect(structuredClone(trace.anchor)).toEqual(trace.anchor)
	})

	it("schema snapshot — drift forces a conscious decision", async () => {
		const tokenizer = await loadTokenizer()
		const text = "350 5th Ave 10118"
		const { pieces } = tokenizer.encode(text)
		const logits = logitsWithBoost(pieces.length, 0, "B-house_number")
		const localeLogits = [10, 0, 0, 0, 0, 0, 0, 0, 0]
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits, localeLogits) })

		const trace = await classifier.traceParse(text, { addressSystemConventions: "auto", spanProposer: false })

		await expect(prettyJSON(trace, false)).toMatchFileSnapshot("../fixtures/trace-schema.snap.json")
	})
})
