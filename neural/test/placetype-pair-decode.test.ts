/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The placetype-pair prior's two REGISTERED decode-order test classes (Task 4 brief): (1) a window
 *   the prior biases stays a united BIO span through the `enforceWordConsistency` heal, and (2) a word
 *   the encoder is confident about (a large contrary logit) is NOT overridden by the prior — the
 *   encoder's veto stays intact at a realistic magnitude. Both exercise `#decode` end-to-end via
 *   `traceParse` + a canned `NeuralRunner` — the same harness `trace-parse.test.ts` uses.
 *
 *   Both fixtures below are the comma-free two-word "Shoreditch London" shape, which is decode-order
 *   plumbing, not a probe-mode test — `probeMode: "window"` is passed explicitly (Task 6 defaulted the
 *   prior to `"segment"` mode, under which this comma-free input would collapse to one inert segment and
 *   never reach the decode-order behavior these tests actually check).
 */

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import { NeuralAddressClassifier, type NeuralRunner } from "../classifier.ts"
import { STAGE2_BIO_LABELS } from "../labels.ts"
import type { InferResult } from "../onnx-runner.ts"
import type { PairIndexLike } from "../pair-index-resolver.ts"
import { MailwomanTokenizer } from "../tokenizer.ts"

const TOKENIZER_PATH = repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

/** Fake runner emitting a canned logits matrix regardless of input — the `trace-parse.test.ts` idiom. */
class FakeRunner implements NeuralRunner {
	constructor(private readonly canned: number[][]) {}
	async infer(_ids: number[]): Promise<InferResult> {
		return { logits: this.canned, numLabels: this.canned[0]?.length ?? 0 }
	}
}

function zeroRow(): number[] {
	return new Array<number>(STAGE2_BIO_LABELS.length).fill(0)
}

function col(label: string): number {
	return STAGE2_BIO_LABELS.indexOf(label as (typeof STAGE2_BIO_LABELS)[number])
}

/** A minimal `PairIndexLike` resolving exactly one (child, parent) pair, at the real artifact's delta (6.0). */
function fixedPairIndex(
	child: string,
	parent: string,
	tag: string,
	delta = 6.0,
	transitionBeta?: number
): PairIndexLike {
	return {
		delta,
		...(transitionBeta !== undefined ? { transitionBeta } : {}),
		probe: (c, p) => (c === child && p === parent ? (tag as never) : undefined),
	}
}

async function loadTokenizer(): Promise<MailwomanTokenizer> {
	return MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
}

describe("placetype-pair prior — decode-order integration", () => {
	it("a biased multi-piece word stays UNITED through enforceWordConsistency", async () => {
		const tokenizer = await loadTokenizer()
		// Fixture tokenizer split: "Shoreditch London" -> ['▁Shore','d','itch','▁London'] — "shoreditch"
		// is pieces 0-2 (one word, three pieces), "london" is piece 3.
		const text = "Shoreditch London"
		const { pieces } = tokenizer.encode(text)
		expect(pieces.map((p) => p.piece)).toEqual(["▁Shore", "d", "itch", "▁London"])

		// WEAK, internally-FRAGMENTED baseline for "shoreditch": B-street / O / B-locality across its 3
		// pieces (magnitude 1) — a legal-but-inconsistent BIO sequence, the exact fragmentation class
		// `enforceWordConsistency` exists to heal. "London" decides decisively on its own (magnitude 5,
		// irrelevant to what's under test).
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

		// Baseline sanity — WITHOUT the placetypePair prior, this exact weak/fragmented logit set really
		// does trigger a wordConsistency heal. Proves the fragmentation premise isn't a strawman.
		const baseline = await classifier.traceParse(text, { spanProposer: false })
		expect(baseline.repairs.find((r) => r.pass === "wordConsistency")).toBeDefined()

		// WITH the bias: the placetypePair prior's own B-first/I-rest write (delta 6.0, dominating the
		// weak magnitude-1 baseline) already makes "shoreditch"'s three pieces unanimous BEFORE
		// enforceWordConsistency runs — there is nothing left for the heal to do.
		const index = fixedPairIndex("shoreditch", "london", "dependent_locality")
		const biased = await classifier.traceParse(text, {
			spanProposer: false,
			placetypePair: { index, probeMode: "window" },
		})

		expect(biased.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: true,
			probePath: "window",
		})
		expect(biased.repairs.find((r) => r.pass === "wordConsistency")).toBeUndefined()

		// The raw decoder path itself (captured BEFORE any heal) is already united across the word.
		const depLocB = col("B-dependent_locality")
		const depLocI = col("I-dependent_locality")
		expect(biased.path.slice(0, 3)).toEqual([depLocB, depLocI, depLocI])
	})

	it("an encoder-confident word is NOT overridden — the encoder veto stays intact at a realistic magnitude", async () => {
		const tokenizer = await loadTokenizer()
		const text = "Shoreditch London"
		const { pieces } = tokenizer.encode(text)
		expect(pieces).toHaveLength(4)

		// STRONG, already-consistent baseline for "shoreditch": B-street / I-street / I-street at
		// magnitude 20 — a realistic "the encoder is sure" margin (softmax-saturating relative to the
		// prior's 6.0 delta; documented here since the brief calls for the exact magnitudes used). The
		// placetypePair prior below would bias the SAME window toward `dependent_locality` at its real
		// artifact's calibrated delta (6.0) — 20 > 6, so the encoder's reading must win.
		const logits = [zeroRow(), zeroRow(), zeroRow(), zeroRow()]
		logits[0]![col("B-street")] = 20
		logits[1]![col("I-street")] = 20
		logits[2]![col("I-street")] = 20
		logits[3]![col("B-locality")] = 5

		const classifier = new NeuralAddressClassifier({ tokenizer, runner: new FakeRunner(logits) })
		const index = fixedPairIndex("shoreditch", "london", "dependent_locality") // delta 6.0

		const trace = await classifier.traceParse(text, {
			spanProposer: false,
			placetypePair: { index, probeMode: "window" },
		})

		expect(trace.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: true,
			probePath: "window",
		})

		const streetB = col("B-street")
		const streetI = col("I-street")

		// The bias DID fire (nonzero emissions delta), but the encoder's 20-vs-6 margin still wins the
		// decode — "shoreditch" decodes street, exactly as the encoder alone would have called it.
		expect(trace.path.slice(0, 3)).toEqual([streetB, streetI, streetI])
	})
})

describe("placetype-pair prior — TRANSITION-BETA chain integration (path-fusion fixture)", () => {
	/**
	 * The task-8 path-fusion lattice, reconstructed on the fixture tokenizer: the emission-side δ (6.0) wins nothing —
	 * "shoreditch"'s fused street run (8 + 7 + 7 = 22) outscores the biased dependent_locality reading (6 + 6 + 6 = 18)
	 * by 4, MORE than the per-piece emission gap but LESS than β=5. So a beta-less decode keeps the fused path (the
	 * measured current-main behavior on the 17 comma-free GB rows), and the transitionBeta artifact flips it — the
	 * probe's recovery mechanism, end-to-end through `#decode` → viterbi. Comma-free input, `probeMode` omitted: the auto
	 * chain's ANCHORED leg is the one that fires, matching the production population.
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
		const index = fixedPairIndex("shoreditch", "london", "dependent_locality") // no transitionBeta

		const trace = await classifier.traceParse("Shoreditch London", {
			spanProposer: false,
			placetypePair: { index },
		})

		// The prior FIRED (anchored leg, emission bias composed) yet the global path stays fused — the exact
		// emission-only miss the task-8 probe measured, and the exact decode a pre-TRANSITION-BETA build produces.
		expect(trace.priors.find((p) => p.kind === "placetypePair")).toEqual({
			kind: "placetypePair",
			applied: true,
			probePath: "anchored",
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
			placetypePair: { index: fixedPairIndex("shoreditch", "london", "dependent_locality", 6.0, 5) },
		})

		// The child span flips whole — entry bonus at the first piece, BIO continuation follows.
		expect(withBeta.path).toEqual([
			col("B-dependent_locality"),
			col("I-dependent_locality"),
			col("I-dependent_locality"),
			col("B-locality"),
		])
		// The beta is a DECODER term: the post-prior emission matrices are byte-identical across the two runs —
		// only the transition side moved.
		expect(withBeta.emissions).toEqual(betaLess.emissions)

		// And the flip lands in the tree the user sees.
		const json = await classifier.parseJSON("Shoreditch London", {
			spanProposer: false,
			placetypePair: { index: fixedPairIndex("shoreditch", "london", "dependent_locality", 6.0, 5) },
		})
		expect(json.dependent_locality).toBe("Shoreditch")
	})
})
