/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every weights package must decode with its MODEL's label vocabulary.
 *
 *   A carrier overlay (`mailwoman.baseWeights` set) ships no model of its own — it shares the base's — so its card
 *   describes the overlay while the vocabulary belongs to the base. An overlay card that omits `labels` is therefore
 *   CORRECT, and the resolver has to fall back rather than the author having to copy 33 strings into every carrier,
 *   which is a duplicate that goes stale on the first retrain.
 *
 *   The failure this pins is silent and total. `NeuralAddressClassifier` falls back to `STAGE2_BIO_LABELS` (21) when no
 *   labels reach it, the shared base emits 33 logits per token, and the first parse throws inside
 *   `assertEmissionWidth` — so the package is not degraded, it is inoperable, and only at runtime.
 *
 *   Presence-checking the card is not enough, which is how this shipped: `resolveWeights` already fell back to the
 *   base card when the overlay's was ABSENT, but four scaffolded carriers had a card that existed and simply had no
 *   `labels` key. Existence and completeness are different questions.
 */

import { existsSync } from "node:fs"

import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier } from "../classifier.ts"
import { readLabelsFromModelCard, resolveWeights } from "../weights.ts"

/**
 * Every locale with a weights workspace. Spelled out rather than discovered: a carrier added without being listed here
 * is exactly the case that broke, so the list failing to grow is itself the signal.
 */
const LOCALES = ["en-US", "en-GB", "fr-FR", "de-DE", "en-IN", "es-ES", "it-IT", "en-NZ"] as const

function haveWeights(locale: string): boolean {
	try {
		const w = resolveWeights({ locale })

		return !!w.modelPath && existsSync(w.modelPath)
	} catch {
		return false
	}
}

describe("weights overlays inherit their base's label vocabulary", () => {
	const baseline = haveWeights("en-US")
		? readLabelsFromModelCard(resolveWeights({ locale: "en-US" }).modelCardPath)
		: undefined

	for (const locale of LOCALES) {
		test.skipIf(!haveWeights(locale))(`${locale} decodes with the model's full vocabulary`, async () => {
			const classifier = await NeuralAddressClassifier.loadFromWeights({ locale })

			// Reaching into `labels` rather than asserting on a parse: a wrong vocabulary throws on the first
			// parse, and a thrown assertion says less than a count comparison does.
			const labels = (classifier as unknown as { labels: readonly string[] }).labels

			expect(labels, `${locale} resolved ${labels.length} labels; en-US resolves ${baseline?.length}`).toHaveLength(
				baseline?.length ?? 0
			)
		})

		test.skipIf(!haveWeights(locale))(`${locale} parses without an emission-width mismatch`, async () => {
			const classifier = await NeuralAddressClassifier.loadFromWeights({ locale })

			await expect(classifier.parse("350 5th Ave, New York, NY 10118")).resolves.toBeDefined()
		})
	}
})
