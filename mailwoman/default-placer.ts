/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default coarse-placer (#244) for the user-facing geocoding surfaces. As of the M2 misrouting
 *   gate (0 misroutes across 2 000 in-map addresses, 10 countries — see
 *   docs/articles/evals/resolver-geo/2026-06-14-coarse-placer-inmap-misroute.md) the soft country prior runs
 *   **on by default**: `geocodeAddress` and `createRuntimePipeline` load THIS bundled placer unless
 *   the caller passes their own `placeCountry` or opts out with `placeCountry: false`.
 *
 *   Loaded LAZILY + cached once per process: the int8 model is ~0.79 MB and `predict` is
 *   microseconds, but the bundled-artifact read is async, so callers `await` it the first time and
 *   reuse the cached promise after. Returns `null` (no prior, graceful) when the bundled model
 *   can't be resolved — a stripped-down install, a missing `data/` dir — so a default-on consumer
 *   degrades to plain resolution instead of throwing.
 */

/** Structural shape of a place-country predictor — matches `RuntimePipelineStages["placeCountry"]`. */
export type PlaceCountryFn = (normalizedText: string) => {
	country: string | null
	confidence: number
	/** Full per-in-map-country distribution (#244 residual). When set it IS the `anchorPosterior`. */
	posterior?: Record<string, number>
}

// Abstention threshold for the default prior — the open-set rule's flat-optimum operating point (#244 M2).
const DEFAULT_ABSTAIN_BELOW = 0.9

let cached: Promise<PlaceCountryFn | null> | null = null

/**
 * Lazy-load + cache the coarse-placer bundled in `@mailwoman/core` as a place-country fn (the M2 open-set rule at the
 * 0.9 operating point). The result is cached for the process; `null` means the model couldn't be loaded and the caller
 * should proceed with no prior.
 */
export function loadDefaultPlaceCountry(): Promise<PlaceCountryFn | null> {
	if (!cached) {
		cached = (async (): Promise<PlaceCountryFn | null> => {
			try {
				const { CoarsePlacer, inMapPosterior } = await import("@mailwoman/core/coarse-placer")
				const placer = await CoarsePlacer.fromBundled({ abstainBelow: DEFAULT_ABSTAIN_BELOW, openSet: true })

				return (text: string) => {
					const p = placer.predict(text)
					// Hand the resolver the full in-map distribution (#244 residual): it boosts every plausible
					// country and breaks ambiguous ties with its own evidence, instead of the lossy one-hot argmax.
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
