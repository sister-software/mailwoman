/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useGeocode` — the parse+resolve state machine for the geocoder map. It REUSES the pipeline's
 *   `useParsePipeline` (text / busy / stage / result / candidate selection) and layers on the two map-only
 *   concerns the geocoder adds over the base explorer:
 *
 *     1. Viewport bias — when the runtime exposes `runParseWithBias`, the current map center (read through
 *        an injected `getBias`, itself reading the `MapRef`) rides along as a soft proximity prior. The
 *        bias is injected by deriving a `runParse` that binds it, so `useParsePipeline` is reused verbatim.
 *     2. The map render place — the selected candidate, enriched by the host's `resolveMapPlace` into the
 *        richer {@link ResolvedMapPlace} the declarative overlays consume (bbox / tier / polygon). Absent
 *        an enricher, the candidate renders as a bare point.
 *
 *   No maplibre import at module scope — the map handle is reached only through the injected `getBias`
 *   callback, so this hook stays independent of the map binding.
 */

import { useMemo } from "react"

import type { ResolvedMapPlace } from "#map/place-render"
import type { GeocoderRuntime, MapBias } from "#map/types"
import type { PipelineRuntime } from "#pipeline/types"
import { useParsePipeline, type UseParsePipeline } from "#pipeline/useParsePipeline"

export interface UseGeocodeOptions {
	/**
	 * The injected geocoder runtime (extends `PipelineRuntime` with the map + bias surface).
	 */
	runtime: GeocoderRuntime
	/**
	 * Address to pre-fill.
	 */
	defaultText: string
	/**
	 * Read the current viewport bias (the map center) at submit time. Absent → no bias.
	 */
	getBias?: () => MapBias | null
}

export interface UseGeocode extends UseParsePipeline {
	/**
	 * The selected candidate enriched into the map-render shape (bbox / tier / polygon), or `null`.
	 */
	mapPlace: ResolvedMapPlace | null
}

export function useGeocode({ runtime, defaultText, getBias }: UseGeocodeOptions): UseGeocode {
	// Bind the viewport bias into a derived `runParse` so `useParsePipeline` is reused unchanged. When the runtime has no
	// bias-aware parse, pass it straight through.
	const geoRuntime = useMemo<PipelineRuntime>(() => {
		const withBias = runtime.runParseWithBias

		if (!withBias) return runtime

		return {
			...runtime,
			runParse: (input, hooks) => withBias(input, getBias?.() ?? null, hooks),
		}
	}, [runtime, getBias])

	const pipeline = useParsePipeline({ runtime: geoRuntime, defaultText })

	const mapPlace = useMemo<ResolvedMapPlace | null>(() => {
		if (!pipeline.selectedCandidate || !pipeline.result) return null

		return runtime.resolveMapPlace
			? runtime.resolveMapPlace(pipeline.selectedCandidate, pipeline.result)
			: pipeline.selectedCandidate
	}, [pipeline.selectedCandidate, pipeline.result, runtime])

	return { ...pipeline, mapPlace }
}
