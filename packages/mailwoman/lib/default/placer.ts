// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The bundled coarse placer, and the place-country service built over it.
 *
 *   A scope builds the service once and every pipeline and session on that scope reads it.
 *   `createRuntimePipeline` registers it on the scope it owns.
 *
 *   `geocodeAddress` holds no scope, so its caller loads the function and passes it.
 *
 *   The service is `null` when the bundled model can't be read, so a consumer runs without the prior.
 */

import type { CoarsePlacer, CoarsePlacerOpts } from "@mailwoman/core/coarse-placer"
import { resolvePackagePathFrom } from "@mailwoman/core/module/resolve-from"
import { createToken, type ServiceRegistry, type ServiceToken } from "async-init"

import { defineUnlessProvided } from "#services/define"

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

/**
 * The settings of {@linkcode loadBundledPlaceCountry}.
 */
export interface PlaceCountryOptions {
	/**
	 * The probability below which the placer abstains.
	 *
	 * @defaultValue `0.9`
	 */
	abstainBelow?: number
}

/**
 * Loads the shipped coarse placer as a place-country function.
 *
 * Every call reads the artifact and builds a new placer, so a caller loads it once and keeps the function.
 * The function hands the resolver the full in-map distribution.
 *
 * That distribution boosts every plausible country, and the resolver's own evidence breaks a tie.
 *
 * @returns `null` when the model can't be loaded, so the caller proceeds with no prior.
 */
export async function loadBundledPlaceCountry(options: PlaceCountryOptions = {}): Promise<PlaceCountryFn | null> {
	try {
		const { inMapPosterior } = await import("@mailwoman/core/coarse-placer")

		const placer = await loadBundledCoarsePlacer({
			abstainBelow: options.abstainBelow ?? DEFAULT_ABSTAIN_BELOW,
			openSet: true,
		})

		return (text: string) => {
			const prediction = placer.predict(text)
			const posterior = inMapPosterior(prediction)

			return {
				country: prediction.country,
				confidence: prediction.confidence,
				...(posterior ? { posterior } : {}),
			}
		}
	} catch {
		return null
	}
}

/**
 * The token of the place-country function over the bundled coarse placer,
 * `null` when the model can't be loaded.
 *
 * @public
 */
export const PlaceCountryService: ServiceToken<PlaceCountryFn | null> = createToken("place-country")

/**
 * Registers the place-country function on `registry`.
 *
 * The placer loads when a caller first needs the service, once for the scope.
 * It holds its weights in memory and opens no handle, so the scope has no release to run for it.
 */
export function registerPlaceCountryService(registry: ServiceRegistry, options: PlaceCountryOptions = {}): void {
	defineUnlessProvided(registry, PlaceCountryService, { build: () => loadBundledPlaceCountry(options) })
}
