/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Do a weights package's DECLARED channels actually FEED on real input? (ROAD_TO_V9 §1 A2/A4.)
 *
 *   The failure this exists to exclude is not "the channel is missing" — the loader already warns
 *   about that. It is the quieter one: a channel that RESOLVES, loads a real lexicon, and then paints
 *   nothing on every row. Two live examples in one week — the en-gb overlay declaring an evidence
 *   bundle it shipped no lexicons for (#1511), and the shaped anchor keyer finding no span in the
 *   lowercase register (#1512). Both loaded clean.
 *
 *   So: load the package exactly as production does (`loadFromWeights`), rebuild the soft-feature
 *   channels for one input, and report per channel how many PIECES carry a non-zero clue. Zero-with-a-
 *   lexicon-loaded is the answer that matters, and it is called out in place.
 *
 *   `--cache-root` grades a candidate laid out as a package-shaped weights dir
 *   (`<cacheRoot>/node_modules/@mailwoman/neural-weights-<locale>`) — the same posture
 *   `score-anchor-v2-boards.run.ts` uses. Omit it to grade the installed workspace package.
 *
 *   Usage: node scripts/overlay-channel-smoke.ts --locale en-gb [--cache-root <dir>]
 */

import { NeuralAddressClassifier, type NeuralAddressClassifierConfig } from "@mailwoman/neural"
// `@mailwoman/neural` exports no `./case-normalize` subpath, and what the anchor channel sees is the
// CASE-NORMALIZED text (#690/#829, default-ON in `parse`) — re-implementing that here is the one thing
// that must not drift, so this repo-local diagnostic imports the module directly (same posture as
// `scripts/probe-gb-anchor-fire.ts`).
import { normalizeInputCase } from "@mailwoman/neural/case-normalize"
import { buildSoftFeatures } from "@mailwoman/neural/soft-features"
import { resolveWeights } from "@mailwoman/neural/weights"
import { parseArgs } from "@mailwoman/platform/util"

const { values } = parseArgs({
	options: {
		locale: { type: "string", default: "en-gb" },
		"cache-root": { type: "string" },
		text: { type: "string", default: "10 Downing Street, Shoreditch, London, SW1A 2AA" },
		"normalize-case": { type: "string", default: "true" },
	},
})

const locale = values.locale!
const cacheRoot = values["cache-root"]
const resolved = resolveWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) })

console.log(`locale            ${locale}`)
console.log(`source            ${resolved.source}`)
console.log(`card              ${resolved.modelCardPath}`)
console.log(`anchor            ${resolved.anchorLookupPath?.path ?? "(none)"}`)
console.log(`streetType        ${resolved.streetTypeLexiconPath ?? "(none)"}`)
console.log(`localitySurface   ${resolved.localitySurfaceLexiconPath ?? "(none)"}`)

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) })
// The channel sources are private config; reach them the way `#decode` does.
const cfg = (classifier as unknown as { cfg: NeuralAddressClassifierConfig }).cfg

const normalizeCase = values["normalize-case"] !== "false"
const text = normalizeCase ? normalizeInputCase(values.text!) : values.text!
const pieces = cfg.tokenizer.encode(text).pieces

const channels = buildSoftFeatures(text, pieces, {
	...(cfg.postcodeAnchorLookup ? { postcodeAnchorLookup: cfg.postcodeAnchorLookup } : {}),
	...(cfg.postcodeAnchorSpanMode ? { postcodeAnchorSpanMode: cfg.postcodeAnchorSpanMode } : {}),
	...(cfg.gazetteerLexicon ? { gazetteerLexicon: cfg.gazetteerLexicon } : {}),
	...(cfg.countryLexicon ? { countryLexicon: cfg.countryLexicon } : {}),
	...(cfg.streetTypeLexicon ? { streetTypeLexicon: cfg.streetTypeLexicon } : {}),
	...(cfg.localitySurfaceLexicon ? { localitySurfaceLexicon: cfg.localitySurfaceLexicon } : {}),
	...(cfg.suppressGazetteerNearPostcode ? { suppressGazetteerNearPostcode: true } : {}),
})

console.log(`\ninput (normalizeCase=${normalizeCase})  ${JSON.stringify(text)}`)
console.log(`pieces            ${pieces.length}`)
console.log(`spanMode          ${JSON.stringify(cfg.postcodeAnchorSpanMode ?? null)}`)
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
