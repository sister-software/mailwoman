// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `useGeocode` — the parse+resolve state machine for the geocoder map.
 *
 *   It reuses the pipeline's `useParsePipeline` (text / busy / stage / result / candidate selection)
 *   and layers on the two map-only concerns the geocoder adds over the base explorer:
 *
 *     1. Viewport bias — when the runtime exposes `runParseWithBias`, the current map center (read through
 *        an injected `getBias`, itself reading the `MapRef`) supplies a soft proximity prior. The
 *        bias is injected by deriving a `runParse` that binds it, so `useParsePipeline` is reused verbatim.
 *     2. The map render place — the selected candidate, enriched by the host's `resolveMapPlace` into the
 *        richer {@link ResolvedMapPlace} the declarative overlays consume (bbox / tier / polygon). Absent
 *        an enricher, the candidate renders as a bare point.
 *
 *   No maplibre import at module scope — the map handle is reached only through the
 *   injected `getBias` callback, so this hook stays independent of the map binding.
 */

import { useCallback, useMemo, useState } from "react"

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
	 * Read the current viewport bias (the map center) at submit time.
	 *
	 * Absent → no bias.
	 */
	getBias?: () => MapBias | null
}

export interface UseGeocode extends UseParsePipeline {
	/**
	 * The pinned place when one is set, else the selected candidate enriched into the
	 * map-render shape (bbox / tier / polygon), or `null`.
	 */
	mapPlace: ResolvedMapPlace | null
	/**
	 * A place the map shows without a parse, such as a clicked label at the tile
	 * feature's own coordinate, or `null`.
	 *
	 * The next submit or reset clears it.
	 */
	pinned: ResolvedMapPlace | null
	/**
	 * Show `place` on the map in place of the result's candidate, or clear the pin with `null`.
	 */
	pin: (place: ResolvedMapPlace | null) => void
}

export function useGeocode({ runtime, defaultText, getBias }: UseGeocodeOptions): UseGeocode {
	// Bind the viewport bias into a derived `runParse` so `useParsePipeline` is reused unchanged.
	// When the runtime has no bias-aware parse, pass it straight through.
	const geoRuntime = useMemo<PipelineRuntime>(() => {
		const withBias = runtime.runParseWithBias

		if (!withBias) return runtime

		return {
			...runtime,
			runParse: (input, hooks) => withBias(input, getBias?.() ?? null, hooks),
		}
	}, [runtime, getBias])

	const pipeline = useParsePipeline({ runtime: geoRuntime, defaultText })
	const [pinned, pin] = useState<ResolvedMapPlace | null>(null)

	const candidatePlace = useMemo<ResolvedMapPlace | null>(() => {
		if (!pipeline.selectedCandidate || !pipeline.result) return null

		return runtime.resolveMapPlace
			? runtime.resolveMapPlace(pipeline.selectedCandidate, pipeline.result)
			: pipeline.selectedCandidate
	}, [pipeline.selectedCandidate, pipeline.result, runtime])

	// A parse answers the question the pin stood in for, so either one clears it.
	const { submit, reset } = pipeline

	const submitAndUnpin = useCallback(
		(query?: string) => {
			pin(null)

			return submit(query)
		},
		[submit]
	)

	const resetAndUnpin = useCallback(() => {
		pin(null)
		reset()
	}, [reset])

	return { ...pipeline, submit: submitAndUnpin, reset: resetAndUnpin, mapPlace: pinned ?? candidatePlace, pinned, pin }
}
