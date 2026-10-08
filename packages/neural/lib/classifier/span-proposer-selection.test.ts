/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-parse selections of the span proposer, placetype census and address-system conventions,
 *   asserted through the parse trace with a stub runner.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

import { NeuralAddressClassifier, type NeuralAddressClassifierConfig, type NeuralRunner } from "#classifier"
import { STAGE2_BIO_LABELS } from "#labels"
import { MailwomanTokenizer } from "#tokenizer"

const TEXT = "Apt 4B, 12 Main Street, Springfield"

const runner: NeuralRunner = {
	async infer(ids) {
		return {
			logits: ids.map(() => STAGE2_BIO_LABELS.map(() => 0)),
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

function classifierWith(config: Partial<NeuralAddressClassifierConfig> = {}): NeuralAddressClassifier {
	return new NeuralAddressClassifier({ tokenizer, runner, ...config })
}

async function proposerApplied(
	classifier: NeuralAddressClassifier,
	spanProposer?: NonNullable<Parameters<NeuralAddressClassifier["traceParse"]>[1]>["spanProposer"]
): Promise<boolean> {
	const trace = await classifier.traceParse(TEXT, spanProposer ? { spanProposer } : {})

	return trace.priors.find((prior) => prior.kind === "spanProposer")?.applied ?? false
}

describe("span proposer selection", () => {
	it("runs the default proposer when neither the config nor the parse chooses", async () => {
		expect(await proposerApplied(classifierWith())).toBe(true)
	})

	it("inherits a config that disabled the proposer", async () => {
		const classifier = classifierWith({ spanProposer: "none" })

		expect(await proposerApplied(classifier)).toBe(false)
		expect(await proposerApplied(classifier, "inherit")).toBe(false)
	})

	it('re-enables the default proposer per parse with "auto"', async () => {
		expect(await proposerApplied(classifierWith({ spanProposer: "none" }), "auto")).toBe(true)
	})

	it('disables the proposer per parse with "none"', async () => {
		expect(await proposerApplied(classifierWith(), "none")).toBe(false)
	})
})

describe("address-system conventions selection", () => {
	it("defaults to off and inherits the config", async () => {
		expect((await classifierWith().traceParse(TEXT)).systemSource).toBe("off")
		expect((await classifierWith({ addressSystemConventions: "us" }).traceParse(TEXT)).systemSource).toBe("pinned")
	})

	it("lets a parse turn configured conventions off", async () => {
		const classifier = classifierWith({ addressSystemConventions: "us" })

		expect((await classifier.traceParse(TEXT, { addressSystemConventions: "off" })).systemSource).toBe("off")
	})
})
