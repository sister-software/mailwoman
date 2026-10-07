/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The placetype-pair prior's two registered decode-order test classes: a window the prior biases
 *   stays a united BIO span through the `enforceWordConsistency` heal. The prior leaves a word
 *   unchanged when the encoder is confident about it.
 *
 *   Both fixtures use the comma-free two-word "Shoreditch London" shape. They pass
 *   `probeMode: "window"` explicitly because the prior's default `"segment"` mode collapses this input to one inert
 *   segment that would never reach the decode-order behavior under test.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { NeuralAddressClassifier, type NeuralRunner } from "#classifier"
import { STAGE2_BIO_LABELS } from "#labels"
import type { InferResult } from "#onnx-runner"
import type { PairIndexLike } from "#pair"
import { MailwomanTokenizer } from "#tokenizer"

const TOKENIZER_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

/**
 * Fake runner emitting a canned logits matrix regardless of input.
 */
class FakeRunner implements NeuralRunner {
	readonly #canned: number[][]

	constructor(canned: number[][]) {
		this.#canned = canned
	}
	async infer(_ids: number[]): Promise<InferResult> {
		return {
			logits: this.#canned,
			numLabels: this.#canned[0]?.length ?? 0,
			localeLogits: null,
			addressSystemLogits: null,
			spanScores: null,
			maxSpan: null,
		}
	}
}

function zeroRow(): number[] {
	return new Array<number>(STAGE2_BIO_LABELS.length).fill(0)
}

function col(label: string): number {
	return STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])
}

/**
 * A minimal `PairIndexLike` resolving exactly one (child, parent) pair, at the real artifact's delta (6.0).
 */
function fixedPairIndex(
	child: string,
	parent: string,
	tag: ComponentTag,
	delta = 6,
	transitionBeta?: number
): PairIndexLike {
	return {
		delta,
		...(transitionBeta !== undefined ? { transitionBeta } : {}),
		// No `parentDelta`: a parent write would move the spans these child-side decode-order
		// tests assert on for reasons unrelated to what they measure.
		probe: (c, p) => (c === child && p === parent ? { tag, parentTag: "locality" } : null),
	}
}

async function loadTokenizer(): Promise<MailwomanTokenizer> {
	return MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
}

describe("placetype-pair prior — decode-order integration", () => {
	it("a biased multi-piece word stays UNITED through enforceWordConsistency", async () => {
		const tokenizer = await loadTokenizer()
		// Fixture tokenizer split: "shoreditch" is pieces 0-2 (one word, three pieces) and "london" is piece 3.
		const text = "Shoreditch London"
		const { pieces } = tokenizer.encode(text)
		expect(pieces.map((p) => p.piece)).toEqual(["▁Shore", "d", "itch", "▁London"])

		// A weak, internally-fragmented baseline for "shoreditch" (B-street / O / B-locality at magnitude 1)
		// is the exact BIO fragmentation class `enforceWordConsistency` heals.
		const logits = [zeroRow(), zeroRow(), zeroRow(), zeroRow()]
		logits[0]![col("B-street")] = 1
		logits[1]![col("O")] = 1
		logits[2]![col("B-locality")] = 1
		logits[3]![col("B-locality")] = 5

		const classifier = new NeuralAddressClassifier({
			tokenizer,
			runner: new FakeRunner(logits),
			enforceWordConsistency: true,
		})

		// Baseline sanity: without the prior this weak/fragmented logit set triggers a heal.
		const baseline = await classifier.traceParse(text, { spanProposer: false })
		expect(baseline.repairs.find((r) => r.pass === "wordConsistency")).toBeDefined()

		// With the prior's B-first/I-rest write at delta 6.0, "shoreditch"'s three pieces are
		// already unanimous before `enforceWordConsistency` runs, leaving the heal no work.
		const index = fixedPairIndex("shoreditch", "london", "dependent_locality")

		const biased = await classifier.traceParse(text, {
			spanProposer: false,
			placetypePair: { index, probeMode: "window" },
		})

		expect(biased.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: true,
			probePath: "window",
			census: null,
			censusProbedParents: null,
		})

		expect(biased.repairs.find((r) => r.pass === "wordConsistency")).toBeUndefined()

		// The raw decoder path itself (captured before any heal) is already united across the word.
		const depLocB = col("B-dependent_locality")
		const depLocI = col("I-dependent_locality")
		expect(biased.path.slice(0, 3)).toEqual([depLocB, depLocI, depLocI])
	})

	it("an encoder-confident word is NOT overridden — the encoder veto stays intact at a realistic magnitude", async () => {
		const tokenizer = await loadTokenizer()
		const text = "Shoreditch London"
		const { pieces } = tokenizer.encode(text)
		expect(pieces).toHaveLength(4)

		// A strong, already-consistent baseline for "shoreditch"
		// (B-street / I-street / I-street at magnitude 20) against the prior's calibrated
		// delta of 6.0: 20 exceeds 6, so the baseline label survives.
		const logits = [zeroRow(), zeroRow(), zeroRow(), zeroRow()]
		logits[0]![col("B-street")] = 20
		logits[1]![col("I-street")] = 20
		logits[2]![col("I-street")] = 20
		logits[3]![col("B-locality")] = 5

		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })
		const index = fixedPairIndex("shoreditch", "london", "dependent_locality")

		const trace = await classifier.traceParse(text, {
			spanProposer: false,
			placetypePair: { index, probeMode: "window" },
		})

		expect(trace.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: true,
			probePath: "window",
			census: null,
			censusProbedParents: null,
		})

		const streetB = col("B-street")
		const streetI = col("I-street")

		// The bias fired, but the encoder's 20-vs-6 margin still wins the decode.
		expect(trace.path.slice(0, 3)).toEqual([streetB, streetI, streetI])
	})
})

describe("placetype-pair prior — TRANSITION-BETA chain integration (path-fusion fixture)", () => {
	/**
	 * The path-fusion lattice on the fixture tokenizer: the emission-side δ (6.0) does not win
	 * because "shoreditch"'s fused street run (8 + 7 + 7 = 22) outscores the biased
	 * dependent_locality reading (6 + 6 + 6 = 18) by 4, so a beta-less decode keeps
	 * the fused path and the transitionBeta artifact flips it.
	 *
	 * Comma-free input with `probeMode` omitted, so the auto chain's anchored leg
	 * fires as it does on the production population.
	 */
	function fusedLogits(): number[][] {
		const logits = [zeroRow(), zeroRow(), zeroRow(), zeroRow()]
		logits[0]![col("B-street")] = 8
		logits[1]![col("I-street")] = 7
		logits[2]![col("I-street")] = 7
		logits[3]![col("B-locality")] = 10

		return logits
	}

	it("beta-less index: the fused street path survives — byte-identity with the pre-beta decode (characterization)", async () => {
		const tokenizer = await loadTokenizer()
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(fusedLogits()) })
		const index = fixedPairIndex("shoreditch", "london", "dependent_locality")

		const trace = await classifier.traceParse("Shoreditch London", {
			spanProposer: false,
			placetypePair: { index },
		})

		// The prior fired yet the global path stays fused — the decode a pre-transition-beta build produces.
		expect(trace.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: true,
			probePath: "anchored",
			census: null,
			censusProbedParents: null,
		})

		expect(trace.path).toEqual([col("B-street"), col("I-street"), col("I-street"), col("B-locality")])
	})

	it("transitionBeta 5: the SAME lattice flips to dependent_locality, with emissions byte-identical to the beta-less run", async () => {
		const tokenizer = await loadTokenizer()
		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(fusedLogits()) })

		const betaLess = await classifier.traceParse("Shoreditch London", {
			spanProposer: false,
			placetypePair: { index: fixedPairIndex("shoreditch", "london", "dependent_locality") },
		})

		const withBeta = await classifier.traceParse("Shoreditch London", {
			spanProposer: false,
			placetypePair: { index: fixedPairIndex("shoreditch", "london", "dependent_locality", 6, 5) },
		})

		// The child span flips whole — entry bonus at the first piece, BIO continuation follows.
		expect(withBeta.path).toEqual([
			col("B-dependent_locality"),
			col("I-dependent_locality"),
			col("I-dependent_locality"),
			col("B-locality"),
		])

		// The beta is a decoder term: the post-prior emission matrices are byte-identical across the two runs.
		// Only the transition side moved.
		expect(withBeta.emissions).toEqual(betaLess.emissions)

		// And the flip lands in the tree the user sees.
		const json = await classifier.parseJSON("Shoreditch London", {
			spanProposer: false,
			placetypePair: { index: fixedPairIndex("shoreditch", "london", "dependent_locality", 6, 5) },
		})

		expect(json.dependent_locality).toBe("Shoreditch")
	})
})
