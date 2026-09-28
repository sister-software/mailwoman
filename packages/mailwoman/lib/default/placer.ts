/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default coarse-placer for the user-facing geocoding surfaces. The soft country prior runs by
 *   default: `geocodeAddress` and `createRuntimePipeline` load this bundled placer unless the caller
 *   passes their own `placeCountry` or opts out with `placeCountry: false`.
 *
 *   Loaded lazily and cached once per process, because the bundled-artifact read is async. Returns
 *   `null` (no prior, graceful) when the bundled model can't be resolved, so a default-on consumer
 *   degrades to plain resolution instead of throwing.
 */

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
 * Lazy-load and cache the coarse-placer bundled in `@mailwoman/core` as a place-country function,
 * returning `null` when the model could not be loaded so the caller proceeds with no prior.
 */
export function loadDefaultPlaceCountry(): Promise<PlaceCountryFn | null> {
	if (!cached) {
		cached = (async (): Promise<PlaceCountryFn | null> => {
			try {
				const { CoarsePlacer, inMapPosterior } = await import("@mailwoman/core/coarse-placer")
				const placer = await CoarsePlacer.fromBundled({ abstainBelow: DEFAULT_ABSTAIN_BELOW, openSet: true })

				return (text: string) => {
					const p = placer.predict(text)
					// Hand the resolver the full in-map distribution. It boosts every plausible country
					// and breaks ambiguous ties with its own evidence, instead of the lossy one-hot
					// argmax.
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
