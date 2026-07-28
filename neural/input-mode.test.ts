/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Register gating fence (Decision A): `parse(text, { inputMode: "formatted" })` must run the
 *   evidence-bundle channels OFF (the curriculum-trained absence identity) while every other channel
 *   feeds unchanged; `"fragmented"` (and the bare-library default, unset) feeds them. Asserted at the
 *   runner boundary via a stub — the same seam the ONNX session sees.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { NeuralAddressClassifier, type NeuralRunner } from "./classifier.ts"
import { parseGazetteerLexicon } from "./gazetteer-inference.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"

const fixture = JSON.parse(
	readFileSync(join(import.meta.dirname, "test", "fixtures", "evidence-parity-v2.json"), "utf8")
)

const LABELS = ["O", "B-street", "I-street", "B-locality", "I-locality"]

function stubRunner(seen: { evidence: unknown[] }): NeuralRunner {
	return {
		async infer(ids, _anchor, _gazetteer, _country, evidence) {
			seen.evidence.push(evidence)

			return { logits: ids.map(() => LABELS.map(() => 0)) }
		},
	} as unknown as NeuralRunner
}

async function makeClassifier(seen: { evidence: unknown[] }) {
	const tokenizer = await MailwomanTokenizer.loadFromFile(
		join(import.meta.dirname, "test", "fixtures", "tokenizer-v0.1.0.model")
	)

	return new NeuralAddressClassifier({
		tokenizer,
		runner: stubRunner(seen),
		labels: LABELS,
		streetTypeLexicon: parseGazetteerLexicon(fixture.street_lexicon),
		localitySurfaceLexicon: parseGazetteerLexicon(fixture.locality_lexicon),
	})
}

describe("inputMode register gating (Decision A)", () => {
	it("formatted mode withholds the evidence channels", async () => {
		const seen = { evidence: [] as unknown[] }
		const classifier = await makeClassifier(seen)

		await classifier.parse("Boulevard des Capucines", { inputMode: "formatted" })
		expect(seen.evidence).toHaveLength(1)
		expect(seen.evidence[0]).toBeUndefined()
	})

	it("fragmented mode (and the bare-library default) feeds them", async () => {
		const seen = { evidence: [] as unknown[] }
		const classifier = await makeClassifier(seen)

		await classifier.parse("Boulevard des Capucines", { inputMode: "fragmented" })
		await classifier.parse("Boulevard des Capucines", {})
		expect(seen.evidence).toHaveLength(2)

		for (const e of seen.evidence) {
			expect(e).toBeDefined()
		}
	})
})
