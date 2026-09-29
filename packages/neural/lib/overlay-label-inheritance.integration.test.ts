/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every weights package must decode with its model's label vocabulary.
 *
 *   A carrier overlay (`mailwoman.baseWeights` set) ships no model of its own. It shares the base's model.
 *   Its card describes the overlay, while the vocabulary belongs to the base. An overlay card that omits `labels` is
 *   correct. The resolver falls back to the base vocabulary, so authors do not copy 33 strings into every carrier.
 *   Those duplicate strings would go stale on the first retrain.
 *
 *   The failure this pins is silent and total. `NeuralAddressClassifier` falls back to `STAGE2_BIO_LABELS` (21) when no
 *   labels reach it. The shared base emits 33 logits per token. The first parse then throws inside
 *   `assertEmissionWidth`. The package is inoperable at runtime.
 *
 *   A card check by itself is insufficient. `resolveWeights` already fell back to the
 *   base card when the overlay's was absent, but four scaffolded carriers had a card that existed and simply had no
 *   `labels` key. Existence and completeness are different questions.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier } from "#classifier"
import { resolveWeights } from "#weights"
import { readLabelsFromModelCard } from "#weights/channels"

/**
 * Every locale with a weights workspace.
 *
 * Spelled out rather than discovered: a carrier added without being listed here is
 * exactly the case that broke, so the list failing to grow is itself the signal.
 */
const LOCALES = ["en-US", "en-GB", "fr-FR", "de-DE", "en-IN", "es-ES", "it-IT", "en-NZ"] as const

async function haveWeights(locale: string): Promise<boolean> {
	try {
		const w = await resolveWeights({ locale })

		return !!w.modelPath && (await pathExists(w.modelPath))
	} catch {
		return false
	}
}

const HAVE_WEIGHTS = new Map<string, boolean>()

for (const locale of LOCALES) {
	HAVE_WEIGHTS.set(locale, await haveWeights(locale))
}

const baseline = HAVE_WEIGHTS.get("en-US")
	? await readLabelsFromModelCard((await resolveWeights({ locale: "en-US" })).modelCardPath)
	: undefined

describe("weights overlays inherit their base's label vocabulary", () => {
	for (const locale of LOCALES) {
		test.skipIf(!HAVE_WEIGHTS.get(locale))(`${locale} decodes with the model's full vocabulary`, async () => {
			const classifier = await NeuralAddressClassifier.loadFromWeights({ locale })

			// A direct `labels` check rather than a parse assertion: a wrong vocabulary
			// throws on the first parse.
			// A thrown assertion reports less than a count comparison.
			const labels = classifier["labels"]

			expect(labels, `${locale} resolved ${labels.length} labels; en-US resolves ${baseline?.length}`).toHaveLength(
				baseline?.length ?? 0
			)
		})

		test.skipIf(!HAVE_WEIGHTS.get(locale))(`${locale} parses without an emission-width mismatch`, async () => {
			const classifier = await NeuralAddressClassifier.loadFromWeights({ locale })

			await expect(classifier.parse("350 5th Ave, New York, NY 10118")).resolves.toBeDefined()
		})
	}
})
