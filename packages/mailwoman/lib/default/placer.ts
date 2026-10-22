/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default coarse-placer for the user-facing geocoding surfaces. The soft country prior runs by
 *   default: `geocodeAddress` and `createRuntimePipeline` load this bundled placer unless the caller
 *   passes their own `placeCountry` or opts out with `placeCountry: "none"`.
 *
 *   Loaded lazily and cached once per process, because the bundled-artifact read is async. Returns
 *   `null` (no prior, graceful) when the bundled model can't be resolved, so a default-on consumer
 *   degrades to plain resolution and does not throw.
 */

import type { CoarsePlacer, CoarsePlacerOpts } from "@mailwoman/core/coarse-placer"
import { resolvePackagePathFrom } from "@mailwoman/core/module/resolve-from"

/**
 * The directory of the coarse-placer artifact this package ships, `data/coarse-placer/`.
 */
export function bundledCoarsePlacerDir(): string {
	return resolvePackagePathFrom(import.meta.url, "mailwoman", "data", "coarse-placer")
}

/**
 * Loads the shipped coarse-placer, or the artifact in `$MAILWOMAN_COARSE_PLACER_DIR` when it is set.
 */
export async function loadBundledCoarsePlacer(opts?: CoarsePlacerOpts): Promise<CoarsePlacer> {
	const { CoarsePlacer } = await import("@mailwoman/core/coarse-placer")

	return CoarsePlacer.fromDefaultDir(bundledCoarsePlacerDir(), opts)
}

/**
 * Structural shape of a place-country predictor, matching `RuntimePipelineStages["placeCountry"]`.
 */
export type PlaceCountryFn = (normalizedText: string) => {
	country: string | null
	confidence: number
	/**
	 * Full per-in-map-country distribution.
	 *
	 * When set it is the `anchorPosterior`.
	 */
	posterior?: Record<string, number>
}

/**
 * Abstention threshold for the default prior, the open-set rule's flat-optimum operating point.
 */
const DEFAULT_ABSTAIN_BELOW = 0.9

let cached: Promise<PlaceCountryFn | null> | null = null

/**
 * Lazy-load and cache the shipped coarse-placer as a place-country function, returning `null`
 * when the model could not be loaded so the caller proceeds with no prior.
 */
export function loadDefaultPlaceCountry(): Promise<PlaceCountryFn | null> {
	if (!cached) {
		cached = (async (): Promise<PlaceCountryFn | null> => {
			try {
				const { inMapPosterior } = await import("@mailwoman/core/coarse-placer")
				const placer = await loadBundledCoarsePlacer({ abstainBelow: DEFAULT_ABSTAIN_BELOW, openSet: true })

				return (text: string) => {
					const p = placer.predict(text)
					// Hand the resolver the full in-map distribution.
					// It boosts every plausible country and breaks ambiguous ties with its own evidence.
					// The lossy one-hot argmax would lose that.
					const posterior = inMapPosterior(p)

					return { country: p.country, confidence: p.confidence, ...(posterior ? { posterior } : {}) }
				}
			} catch {
				return null
			}
		})()
	}

	return cached
}
