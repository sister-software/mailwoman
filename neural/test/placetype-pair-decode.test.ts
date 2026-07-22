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
function fixedPairIndex(child: string, parent: string, tag: string, delta = 6.0): PairIndexLike {
	return {
		delta,
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
		const biased = await classifier.traceParse(text, { spanProposer: false, placetypePair: { index } })

		expect(biased.priors.find((p) => p.kind === "placetypePair")).toEqual({ kind: "placetypePair", applied: true })
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

		const trace = await classifier.traceParse(text, { spanProposer: false, placetypePair: { index } })

		expect(trace.priors.find((p) => p.kind === "placetypePair")).toEqual({ kind: "placetypePair", applied: true })

		const streetB = col("B-street")
		const streetI = col("I-street")

		// The bias DID fire (nonzero emissions delta), but the encoder's 20-vs-6 margin still wins the
		// decode — "shoreditch" decodes street, exactly as the encoder alone would have called it.
		expect(trace.path.slice(0, 3)).toEqual([streetB, streetI, streetI])
	})
})
