/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests that tracing leaves the parse unchanged and that the trace's decode explanation adds up to
 *   the score the decoder computed, with a stub runner whose logits vary by piece.
 */

import { buildAddressTree } from "@mailwoman/core/decoder"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { mulberry32 } from "@mailwoman/core/random"
import { describe, expect, it } from "vitest"

import { NeuralAddressClassifier, type NeuralRunner } from "#classifier"
import { DECODE_TERMS, type DecodeTermValues } from "#decode-explanation"
import { STAGE2_BIO_LABELS } from "#labels"
import { MailwomanTokenizer } from "#tokenizer"
import { buildBIOEndMask, buildBIOStartMask, buildBIOTransitionMask, viterbi } from "#viterbi"

const ADDRESSES = [
	"Apt 4B, 12 Main Street, Springfield",
	"350 5th Ave, New York, NY 10118",
	"10 Rue de Rivoli, 75004 Paris",
	"Wilmslow Road, Didsbury, Manchester, M20 2QZ",
	"PO Box 190, Gaborone, Botswana",
]

/**
 * Logits drawn from a generator seeded by each piece's vocabulary ID, so a decode has several spans.
 */
const runner: NeuralRunner = {
	async infer(ids) {
		return {
			logits: ids.map((id) => {
				const random = mulberry32(id + 1)

				return STAGE2_BIO_LABELS.map(() => (random() - 0.5) * 8)
			}),
			numLabels: STAGE2_BIO_LABELS.length,
			localeLogits: null,
			addressSystemLogits: null,
			spanScores: null,
			maxSpan: null,
		}
	},
}

const tokenizer = await MailwomanTokenizer.loadFromFile(
	resolvePackagePath("@mailwoman/neural", "test", "fixtures", "tokenizer-v0.1.0.model")
)

function termTotal(values: DecodeTermValues): number {
	return DECODE_TERMS.reduce((total, term) => total + values[term], 0)
}

describe.each([
	{ name: "default priors", classifier: new NeuralAddressClassifier({ tokenizer, runner }) },
	{
		name: "a pinned conventions mask",
		classifier: new NeuralAddressClassifier({ tokenizer, runner, addressSystemConventions: "fr" }),
	},
	{ name: "argmax decoding", classifier: new NeuralAddressClassifier({ tokenizer, runner, decode: "argmax" }) },
])("NeuralAddressClassifier with $name", ({ classifier }) => {
	it.each(ADDRESSES)("parses %s identically with tracing on and off", async (address) => {
		const tree = await classifier.parse(address)
		const trace = await classifier.traceParse(address)

		expect(buildAddressTree(trace.text, trace.tokens)).toEqual(tree)
		expect(await classifier.parse(address)).toEqual(tree)
	})

	it.each(ADDRESSES)("explains %s with terms that sum to the decoder's score and margins", async (address) => {
		const trace = await classifier.traceParse(address)
		const explanation = trace.explanation!

		expect(termTotal(explanation.decodedTerms)).toBeCloseTo(explanation.decoderScore, 6)

		if (trace.decode === "viterbi") {
			const labels = STAGE2_BIO_LABELS

			const { path, score } = viterbi({
				emissions: trace.emissions,
				transitions: buildBIOTransitionMask(labels),
				startTransitions: buildBIOStartMask(labels),
				endTransitions: buildBIOEndMask(labels),
			})

			expect(path).toEqual(trace.path)
			expect(explanation.decoderScore).toBe(score)
		}

		expect(explanation.spans.flatMap((span) => span.labels)).toEqual(trace.path.map((k) => trace.labels[k]))

		for (const span of explanation.spans) {
			expect(termTotal(span.termMargins!)).toBeCloseTo(span.margin!, 6)
		}

		const applied = trace.priors.filter((prior) => prior.applied).map((prior) => prior.kind)

		for (const entry of explanation.ledger) {
			expect(applied).toContain(entry.prior)
		}
	})
})

it("returns a null explanation for empty input", async () => {
	expect((await new NeuralAddressClassifier({ tokenizer, runner }).traceParse("")).explanation).toBeNull()
})
