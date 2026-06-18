/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locale-parity drift-guard (#721). `publish.yml` copies en-us's `model.onnx` into the fr-fr
 *   weights package ("one multi-locale model serves both"), so the PUBLISHED fr-fr package ships
 *   en-us's EXACT binary. Its model-card must therefore declare the same label geometry + ship-config
 *   — a drift (the #721 bug: fr-fr stuck at 21 labels while en-us shipped 33) means the card
 *   mis-describes its own weights and `createScorer` throws `model emits N logits ... configured with
 *   only M labels` at load.
 *
 *   This guard fails the moment en-us's labels / components / requires change without fr-fr following.
 *   Pure JSON (no weights) → CI-safe. If fr-fr ever ships its OWN model, relax this to the shared
 *   subset and drop the `cp` in publish.yml.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const readCard = (rel: string) => JSON.parse(readFileSync(resolve(here, rel), "utf8"))
const enUs = readCard("../../neural-weights-en-us/model-card.json")
const frFr = readCard("../../neural-weights-fr-fr/model-card.json")

describe("fr-fr ↔ en-us model-card parity (#721 — fr-fr ships en-us's model via publish.yml cp)", () => {
	test("labels are identical (fr-fr must decode the en-us binary's 33 logits)", () => {
		expect(frFr.labels).toEqual(enUs.labels)
	})

	test("components_supported are identical", () => {
		expect(frFr.components_supported).toEqual(enUs.components_supported)
	})

	test("fr-fr declares the same required channels as en-us (the full ship-config)", () => {
		expect(frFr.requires).toBeDefined()
		expect(frFr.requires.anchor?.required).toBe(enUs.requires.anchor?.required)
		expect(frFr.requires.gazetteer?.required).toBe(enUs.requires.gazetteer?.required)
		expect(frFr.requires.conventions?.mode).toBe(enUs.requires.conventions?.mode)
		expect(frFr.requires.suppress_gazetteer_near_postcode).toBe(enUs.requires.suppress_gazetteer_near_postcode)
	})
})
