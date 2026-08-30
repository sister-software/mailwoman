/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locale-parity drift-guard (#721). `publish.yml` copies en-us's `model.onnx` into the fr-fr
 *   weights package ("one multi-locale model serves both"), so the PUBLISHED fr-fr package ships
 *   en-us's EXACT binary. Its model-card must therefore declare the same label geometry +
 *   ship-config — a drift (the #721 bug: fr-fr stuck at 21 labels while en-us shipped 33) means the
 *   card mis-describes its own weights and `createScorer` throws `model emits N logits ...
 *   configured with only M labels` at load.
 *
 *   This guard fails the moment en-us's labels / components / requires change without fr-fr
 *   following. Pure JSON (no weights) → CI-safe. If fr-fr ever ships its OWN model, relax this to
 *   the shared subset and drop the `cp` in publish.yml.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { fileURLToPath } from "@mailwoman/platform/url"
import { describe, expect, test } from "vitest"

/**
 * The slice of the model card this parity guard reads. Deliberately partial — a field is added here only when an
 * assertion below needs it.
 */
interface ModelCard {
	labels: string[]
	components_supported: string[]
	requires?: {
		anchor?: { required?: boolean }
		gazetteer?: { required?: boolean }
		conventions?: { mode?: string }
		suppress_gazetteer_near_postcode?: boolean
		locality_surface?: EvidenceChannel
		street_type?: EvidenceChannel
	}
}

/**
 * One evidence-lexicon channel as a card declares it. `lexicon` names the GENERATION the model trained against, and
 * declaring it is what arms the #1510 mismatch guard — `resolveEvidenceLexicon` only compares generations on the
 * declared branch, so an undeclared channel silently falls back to a legacy filename with no guard at all.
 */
interface EvidenceChannel {
	required?: boolean
	feature_dim?: number
	slots?: string[]
	lexicon?: string
}

const readCard = async (locale: string) =>
	await readLocalJSONFile<ModelCard>(
		fileURLToPath(import.meta.resolve(`@mailwoman/neural-weights-${locale}/model-card.json`))
	)

const enUs = await readCard("en-us")
const frFr = await readCard("fr-fr")

describe("fr-fr ↔ en-us model-card parity (#721 — fr-fr ships en-us's model via publish.yml cp)", () => {
	test("labels are identical (fr-fr must decode the en-us binary's 33 logits)", () => {
		expect(frFr.labels).toEqual(enUs.labels)
	})

	test("components_supported are identical", () => {
		expect(frFr.components_supported).toEqual(enUs.components_supported)
	})

	test("fr-fr declares the same required channels as en-us (the full ship-config)", () => {
		expect(frFr.requires).toBeDefined()
		expect(frFr.requires!.anchor?.required).toBe(enUs.requires!.anchor?.required)
		expect(frFr.requires!.gazetteer?.required).toBe(enUs.requires!.gazetteer?.required)
		expect(frFr.requires!.conventions?.mode).toBe(enUs.requires!.conventions?.mode)
		expect(frFr.requires!.suppress_gazetteer_near_postcode).toBe(enUs.requires!.suppress_gazetteer_near_postcode)
	})
})

/**
 * Every overlay shares the base `model.onnx` byte-for-byte, so the trained ship-config is the base's and an overlay
 * that declares a `requires` block at all must declare the base's evidence channels within it.
 *
 * The subset case is not a smaller claim, it is a WRONG one. A declared block suppresses the graph-inference
 * back-compat path, so a missing channel is not inferred — it is dropped, and `required` defaulting to false means
 * nothing fails closed. That is how en-gb ran the whole bundle OFF on a model trained WITH it (#1511), and the same gap
 * was later found on fr-fr, en-au and en-nz.
 *
 * An overlay with NO block is deliberately exempt: `ProductionScorer` then infers the channels from the ONNX graph,
 * which is the base's, so it gets the right set for free.
 */
const OVERLAYS_WITH_CARDS = ["fr-fr", "en-gb", "en-au", "en-nz", "de-de", "es-es", "it-it", "en-in"] as const

/**
 * The channels whose declaration also names an artifact generation. These are the ones that drifted.
 */
const EVIDENCE_CHANNELS = ["locality_surface", "street_type"] as const

/**
 * Drop the `$`-prefixed annotation keys before comparing. They carry per-card history and are expected to differ; the
 * declaration they annotate is what has to match.
 */
function semanticFields(channel: EvidenceChannel | undefined): Record<string, unknown> | undefined {
	if (!channel) return undefined

	return Object.fromEntries(Object.entries(channel).filter(([k]) => !k.startsWith("$")))
}

describe("overlay ↔ base evidence-channel parity (#1511 class — a declared block must not be a subset)", () => {
	for (const overlay of OVERLAYS_WITH_CARDS) {
		for (const channel of EVIDENCE_CHANNELS) {
			test(`${overlay} declares ${channel} as the base does, or declares no block at all`, async () => {
				const card = await readCard(overlay)
				// A card with no block is exempt by design (graph inference covers it), so the expected value is the
				// base's declaration only when this overlay declares anything at all.
				const expected = card.requires ? semanticFields(enUs.requires![channel]) : undefined

				expect(semanticFields(card.requires?.[channel])).toEqual(expected)
			})
		}
	}
})
