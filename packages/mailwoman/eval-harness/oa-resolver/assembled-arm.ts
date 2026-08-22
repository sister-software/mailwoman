/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The assembled arm — the full runtime pipeline, wired to the SAME classifier and resolver the bare neural arm
 *   uses so the two arms differ only in the assembly between them.
 */

import { COARSE_CLASSES } from "@mailwoman/core/coarse-placer"

import { createRuntimePipeline, loadDefaultPlaceCountry } from "#index"

import type { OAResolverEvalOptions } from "./options.ts"
import type { buildParseRig } from "./parse-rig.ts"

/**
 * The rig pieces the assembled pipeline shares with the bare neural arm. Sharing them is the whole point: an arm-to-arm
 * delta that also swapped the classifier or the gazetteer would measure nothing.
 */
type SharedRig = Pick<Awaited<ReturnType<typeof buildParseRig>>, "neural" | "resolver">

/**
 * Wire the assembled arm. `assembledPipeline` is `null` when the run does not grade it, which is the default: the arm
 * is opt-in so an ordinary run stays byte-identical to the bare neural one.
 */
export async function buildAssembledArm(
	options: OAResolverEvalOptions,
	rig: SharedRig,
	reportError: (line: string) => void
) {
	const { neural, resolver } = rig

	// #478 inc 3 leg 2 — the ASSEMBLED arms. Route each row through `createRuntimePipeline` using the
	// SAME neural classifier (postcodeRepair on, for comparability with the neural arm) and the SAME
	// resolver — without (`assembled`) and with (`assembled+arb`) per-component arbitration. The
	// street+house_number precondition (the thing #566 broke) is counted per arm so a regression is
	// visible directly.
	//
	// placeCountry default is OFF here (`false`) so the assembled arm isolates arbitration from the
	// #244 coarse prior. But the SHIPPED `createRuntimePipeline`/`geocodeAddress` default IS the
	// bundled placer (on, open-set @ 0.9). `--place-country` flips this eval to the production-
	// representative config — load the same bundled placer and feed it to the pipeline — which is the
	// #743 EU country-constraint integrity fix: without it the assembled EU coords are not what a real
	// caller sees (ambiguous EU names without a country constraint land off-continent).
	const runAssembled = options.assembled ?? false
	// `--place-country-hard` (#194/#743) promotes a CONFIDENT placer guess to a HARD country filter
	// (empty→unresolved) — the lever for the low-pop EU tail the soft prior can't move. Production-
	// representative: gated by the built-in coverage safelist (only well-covered countries hard-filter).
	// `--place-country-hard-all` measures UNGATED (every confident country hard-filters, via a safelist
	// override of the full in-map set) — how per-country hard-resolve-rates are measured to GROW the
	// safelist. Both imply the placer is loaded.
	const useHardCountryAll = options.placeCountryHardAll ?? false
	const useHardCountry = (options.placeCountryHard ?? false) || useHardCountryAll
	const usePlaceCountry = (options.placeCountry ?? false) || useHardCountry
	const evalPlacer = runAssembled && usePlaceCountry ? await loadDefaultPlaceCountry() : null

	if (usePlaceCountry && !evalPlacer) {
		reportError("--place-country requested but the bundled coarse-placer failed to load; running placeCountry OFF.")
	}

	const assembledPipeline = runAssembled
		? createRuntimePipeline({
				classifier: {
					parse: (text: string, o?: object) => neural.parse(text, { ...o, postcodeRepair: true }),
					// `autoLoadWeightsFST` (runtime-pipeline.ts) reads `fstPath` OFF THE CLASSIFIER, so this
					// shim — which exists only to force `postcodeRepair: true` — silently dropped the
					// gazetteer prior for every assembled run before #1497. A bare `{ parse }` literal has no
					// `fstPath` key, `"fstPath" in classifier` is false, and the pipeline degrades to the
					// no-FST default without a word. Forward it.
					...(neural.fstPath ? { fstPath: neural.fstPath } : {}),
				},
				resolver,
				placeCountry: evalPlacer ?? false,
				hardPlaceCountry: useHardCountry && !!evalPlacer,
				// `--place-country-hard-all` overrides the production coverage safelist with the full in-map
				// set, so EVERY confident country hard-filters (ungated measurement). Plain `--place-country-hard`
				// leaves it undefined → the built-in safelist (production-representative).
				...(useHardCountryAll
					? { hardCountrySafelist: new Set(COARSE_CLASSES.filter((c) => c !== "OTHER")) as ReadonlySet<string> }
					: {}),
			})
		: null

	return { runAssembled, assembledPipeline }
}
