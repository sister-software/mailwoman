/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The assembled arm — the full runtime pipeline, wired to the same classifier and resolver the bare neural arm
 *   uses so the two arms differ only in the assembly between them.
 */

import { COARSE_CLASSES } from "@mailwoman/core/coarse-placer"

import type { OAResolverEvalOptions } from "#eval-harness/oa/resolver/options"
import type { buildParseRig } from "#eval-harness/oa/resolver/parse-rig"
import { createRuntimePipeline, loadDefaultPlaceCountry } from "#index"

/**
 * The rig pieces the assembled pipeline shares with the bare neural arm,
 * so an arm-to-arm delta does not also swap the classifier or the gazetteer.
 */
type SharedRig = Pick<Awaited<ReturnType<typeof buildParseRig>>, "neural" | "resolver">

/**
 * Wire the assembled arm; `assembledPipeline` is `null` by default so an ordinary
 * run stays byte-identical to the bare neural one.
 */
export async function buildAssembledArm(
	options: OAResolverEvalOptions,
	rig: SharedRig,
	reportError: (line: string) => void
) {
	const { neural, resolver } = rig

	// Route each row through `createRuntimePipeline` using the same neural classifier
	// (postcodeRepair on, for comparability with the neural arm) and the same resolver —
	// without (`assembled`) and with (`assembled+arb`) per-component arbitration,
	// counted per arm so a regression is visible.
	//
	// placeCountry defaults off so the assembled arm isolates arbitration from the coarse prior;
	// the shipped pipeline default is the bundled placer (on, open-set @ 0.9).
	// `--place-country` flips this eval to the production-representative config,
	// because without it ambiguous EU names are placed off-continent.
	const runAssembled = options.assembled ?? false
	// `--place-country-hard` promotes a confident placer guess to a hard country filter
	// (empty→unresolved), production-representative and conditional on the built-in coverage safelist.
	// `--place-country-hard-all` measures unrestricted (every confident country hard-filters,
	// via a safelist override of the full in-map set) to grow that safelist.
	// Both imply the placer is loaded.
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
					// `autoLoadWeightsFST` reads `fstPath` off the classifier, so a bare `{ parse }`
					// shim silently drops the gazetteer prior: `"fstPath" in classifier` is false
					// and the pipeline degrades to the no-FST default without a word.
					// Forward it.
					...(neural.fstPath ? { fstPath: neural.fstPath } : {}),
				},
				resolver,
				placeCountry: evalPlacer ?? false,
				hardPlaceCountry: useHardCountry && !!evalPlacer,
				// `--place-country-hard-all` overrides the production coverage safelist
				// with the full in-map set so every confident country hard-filters;
				// plain `--place-country-hard` leaves it undefined.
				...(useHardCountryAll
					? { hardCountrySafelist: new Set(COARSE_CLASSES.filter((c) => c !== "OTHER")) as ReadonlySet<string> }
					: {}),
			})
		: null

	return { runAssembled, assembledPipeline }
}
