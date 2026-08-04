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

import { parseJSONStrict } from "@mailwoman/core/objects"
import { describe, expect, it } from "vitest"

import { NeuralAddressClassifier, type NeuralRunner } from "./classifier.ts"
import { parseGazetteerLexicon } from "./gazetteer-inference.ts"
import { MailwomanTokenizer } from "./tokenizer.ts"

interface Fixture {
	street_lexicon: Parameters<typeof parseGazetteerLexicon>[0]
	locality_lexicon: Parameters<typeof parseGazetteerLexicon>[0]
}

const fixture = parseJSONStrict<Fixture>(
	readFileSync(join(import.meta.dirname, "test", "fixtures", "evidence-parity-v2.json"), "utf8")
)

const LABELS = ["O", "B-street", "I-street", "B-locality", "I-locality"]

function stubRunner(seen: { evidence: unknown[] }): NeuralRunner {
	return {
		async infer(...args: Parameters<NeuralRunner["infer"]>) {
			const [ids] = args
			const evidence = args[4]
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

	it("street-context gate: a bare place name feeds NO locality evidence even in fragmented mode", async () => {
		// The 8.2.0 pre-ship gauntlet catch: homograph-flagged locality evidence on a bare world-city
		// lookup rotates the parse (locality → region/street). No street context → locality channel
		// withheld (the declared-ablation identity); the street channel is inert on such input anyway.
		const seen = { evidence: [] as unknown[] }
		const classifier = await makeClassifier(seen)

		await classifier.parse("Springfield", { inputMode: "fragmented" })
		expect(seen.evidence).toHaveLength(1)
		// The street channel rides (all-zero confidence on a street-word-less input — inert by
		// construction); the LOCALITY channel is what the gate withholds.
		const evidence = seen.evidence[0] as { streetType?: unknown; localitySurface?: unknown }
		expect(evidence.localitySurface).toBeUndefined()
		expect(evidence.streetType).toBeDefined()
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
