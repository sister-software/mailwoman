/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A2 receipt — does the SHIP OBLIGATION actually fail closed? (ROAD_TO_V9 §1.)
 *
 *   The obligation: a model trained against a lookup with letter-bearing keys must ship a card
 *   declaring `"requires": { "anchor": { "required": true, "span_mode": "shaped" } }`. Omit it and the
 *   default alnum-run scan runs, which can never produce a space-containing key — so the channel loads,
 *   reports nothing wrong, and feeds zeros on exactly the rows the lookup exists for.
 *
 *   Nothing about the mode is observable from the ONNX graph (the inputs are identical either way), so
 *   the check is on the artifact PAIRING: a lookup carrying GB unit keys next to a card that cannot
 *   reach them. `createScorer` throws on it; `loadFromWeights` warns once. This probe runs a package
 *   through both and reports which fired.
 *
 *   Usage: node scripts/probe-shaped-obligation.ts --cache-root <dir> [--locale en-gb]
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createScorer } from "@mailwoman/neural/scorer"
import { resolveWeights } from "@mailwoman/neural/weights"
import { join } from "@mailwoman/platform/path"
import { parseArgs } from "@mailwoman/platform/util"

const { values } = parseArgs({
	options: {
		locale: { type: "string", default: "en-gb" },
		"cache-root": { type: "string" },
	},
})

const locale = values.locale!
const cacheRoot = values["cache-root"]
const resolved = resolveWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) })

console.log(`card    ${resolved.modelCardPath}`)
console.log(`anchor  ${resolved.anchorLookupPath?.path ?? "(none)"}`)

// --- createScorer: fail CLOSED ------------------------------------------------------------
const packageDir = resolved.modelCardPath ? join(resolved.modelCardPath, "..") : ""

try {
	await createScorer({
		modelPath: resolved.modelPath,
		tokenizerPath: resolved.tokenizerPath,
		modelCardPath: resolved.modelCardPath!,
		locale,
		// Point the scorer at the PACKAGE's own siblings — its repo/data-root defaults would otherwise
		// feed a different bundle's artifacts than the one under test. That default is not hypothetical:
		// on a machine where `$MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json` exists, an unpinned
		// non-shaped card grades against 67,708 letter-free keys instead of the package's own binary.
		...(resolved.anchorLookupPath ? { anchorLookupPath: resolved.anchorLookupPath.path } : {}),
		...((await pathExists(join(packageDir, "anchor-lexicon-v1.json")))
			? { gazetteerLexiconPath: join(packageDir, "anchor-lexicon-v1.json") }
			: {}),
		...(resolved.streetTypeLexiconPath ? { streetTypeLexiconPath: resolved.streetTypeLexiconPath } : {}),
		...(resolved.localitySurfaceLexiconPath ? { localitySurfaceLexiconPath: resolved.localitySurfaceLexiconPath } : {}),
		...(resolved.countryLexiconPath ? { countryLexiconPath: resolved.countryLexiconPath } : {}),
	})

	console.log(`\ncreateScorer      LOADED (no obligation violation)`)
} catch (error) {
	console.log(`\ncreateScorer      THREW ${(error as Error).name}`)
	console.log(`                  ${(error as Error).message}`)
}

// --- the runtime path: warn ONCE, tolerant by contract ------------------------------------
// The warning fires from `buildSoftFeatures`, not from the loader, so the probe has to PARSE — that
// placement is deliberate (it is the only site where the lookup and the declared mode are both in
// hand, so it covers every construction path), and a probe that only loaded would report a false OK.
const errors: string[] = []
const original = console.error
console.error = (...args: unknown[]) => void errors.push(String(args[0]))

try {
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) })
	await classifier.parse("10 Downing Street, London, SW1A 2AA")
} finally {
	console.error = original
}

const obligationWarning = errors.find((line) => line.includes("GB unit keys"))

console.log(`\nruntime parse     ${obligationWarning ? "WARNED" : "silent (no obligation violation)"}`)

if (obligationWarning) {
	console.log(`                  ${obligationWarning}`)
}
