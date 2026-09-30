/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Smoke-test that declared channels feed real input (ROAD_TO_V9 §1 A2/A4).
 *
 *   This catches a channel that resolves and loads but emits only zeros.
 *   The script loads weights via `loadFromWeights` and rebuilds soft features for one input.
 *   It reports per-channel non-zero coverage.
 *
 *   `--cache-root` checks a package-shaped candidate:
 *   `<cacheRoot>/node_modules/@mailwoman/neural-weights-<locale>`.
 *   If omitted, it checks the installed workspace package.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/overlay-channel-smoke.run.ts --locale en-gb [--cache-root <dir>]
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { buildSoftFeatures } from "@mailwoman/neural/soft-features"
import { resolveWeights } from "@mailwoman/neural/weights"
import { normalizeInputCase } from "@mailwoman/normalize/case"

const { values } = parseArguments({
	options: {
		locale: { type: "string", default: "en-gb" },
		"cache-root": { type: "string" },
		text: { type: "string", default: "10 Downing Street, Shoreditch, London, SW1A 2AA" },
		"normalize-case": { type: "string", default: "true" },
	},
})

const locale = values.locale!
const cacheRoot = values["cache-root"]
const resolved = await resolveWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) })

console.log(`locale            ${locale}`)
console.log(`source            ${resolved.source}`)
console.log(`card              ${resolved.modelCardPath}`)
console.log(`anchor            ${resolved.anchorLookupPath?.path ?? "(none)"}`)
console.log(`streetType        ${resolved.streetTypeLexiconPath ?? "(none)"}`)
console.log(`localitySurface   ${resolved.localitySurfaceLexiconPath ?? "(none)"}`)

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) })
const cfg = classifier.config

const normalizeCase = values["normalize-case"] !== "false"
const text = normalizeCase ? normalizeInputCase(values.text!) : values.text!
const pieces = cfg.tokenizer!.encode(text).pieces

const channels = buildSoftFeatures(text, pieces, {
	...(cfg.postcodeAnchorLookup ? { postcodeAnchorLookup: cfg.postcodeAnchorLookup } : {}),
	...(cfg.postcodeAnchorSpanMode ? { postcodeAnchorSpanMode: cfg.postcodeAnchorSpanMode } : {}),
	...(cfg.gazetteerLexicon ? { gazetteerLexicon: cfg.gazetteerLexicon } : {}),
	...(cfg.countryLexicon ? { countryLexicon: cfg.countryLexicon } : {}),
	...(cfg.streetTypeLexicon ? { streetTypeLexicon: cfg.streetTypeLexicon } : {}),
	...(cfg.localitySurfaceLexicon ? { localitySurfaceLexicon: cfg.localitySurfaceLexicon } : {}),
	...(cfg.suppressGazetteerNearPostcode ? { suppressGazetteerNearPostcode: true } : {}),
})

console.log(`\ninput (normalizeCase=${normalizeCase})  ${stringifyJSON(text)}`)
console.log(`pieces            ${pieces.length}`)
console.log(`spanMode          ${stringifyJSON(cfg.postcodeAnchorSpanMode ?? null)}`)
console.log("\nchannel           lexicon?  pieces with a non-zero clue")

for (const name of ["anchor", "gazetteer", "country", "streetType", "localitySurface"] as const) {
	const channel = (channels as Record<string, { features: number[][] } | undefined>)[name]

	if (!channel) {
		console.log(`${name.padEnd(18)} NO        — channel not constructed (source absent)`)

		continue
	}

	const fed = channel.features.filter((row) => row.some((v) => v !== 0)).length

	console.log(`${name.padEnd(18)} yes       ${fed}/${pieces.length}${fed === 0 ? "   <-- RESOLVED BUT SILENT" : ""}`)
}
