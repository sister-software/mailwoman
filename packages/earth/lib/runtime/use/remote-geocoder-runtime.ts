/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useRemoteGeocoderRuntime` builds the {@link GeocoderRuntime} that parses and geocodes through the hosted
 *   native API. It loads no release manifest, model, FST or gazetteer database, so the page's cold load is the
 *   basemap and the app bundle.
 */

import type { GeocodeBiasPoint } from "@mailwoman/api/operations/geocode/address"
import type { EngineStamp } from "@mailwoman/core/license"
import type { ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { GeocoderRuntime, MapBias, ResolvedMapPlace, Suggestion } from "@mailwoman/react/map"
import { useCallback, useMemo, useState } from "react"

import type { EarthConfig } from "#config"
import { pageSearchParam } from "#routes"
import { REMOTE_PARSE_STAGE_LABELS, remoteGeocode } from "#runtime/remote-geocoder"
import { useGeoBias } from "#runtime/use/geo-bias"
import {
	type GeocoderRuntimeHandle,
	type GeocoderRuntimeOptions,
	useEarthMapStyle,
	useEarthOverlays,
} from "#runtime/use/geocoder-runtime"

/**
 * The hosted API the page geocodes through, or `null` when the page runs the model in the browser.
 *
 * `?geocoder=local` selects the browser runtime, `?geocoder-api=<URL>` selects that API,
 * and otherwise the configured {@link EarthConfig.geocoderAPIURL} decides.
 */
export function remoteGeocoderURL(config: EarthConfig): URL | null {
	if (pageSearchParam("geocoder") === "local") return null

	const override = pageSearchParam("geocoder-api")

	return override ? new URL(override) : config.geocoderAPIURL
}

/**
 * The weight of the viewport center among a search's bias points, as the browser runtime weighs it.
 */
const VIEWPORT_BIAS_WEIGHT = 1

/**
 * The weight of the granted device location, as the browser runtime weighs it.
 */
const DEVICE_LOCATION_BIAS_WEIGHT = 0.6

function resolveMapPlace(candidate: ResolvedPlaceView): ResolvedMapPlace {
	// TODO: A hosted answer renders as a point, because the crisp admin polygon the browser
	// runtime draws comes from the release's `wof-polygons.db`, which this runtime does not load.
	// Either a `/v1/place/{id}/geometry` route on the API, or a byte-range read of
	// `wof-polygons.db` keyed by the candidate's Who's On First ID, would supply it.
	return { ...candidate }
}

/**
 * Suggestions for the search box's typed prefix.
 *
 * TODO: The hosted API has no completion route yet, so this answers no suggestions.
 * A `/v1/autocomplete` route, which another lane owns, would answer them, and this function would call it.
 */
async function noRemoteSuggestions(): Promise<Suggestion[]> {
	return []
}

/**
 * Build the {@link GeocoderRuntime} that sends each address to the hosted API at `apiURL`.
 */
export function useRemoteGeocoderRuntime(
	apiURL: URL,
	{ config, initialCenter, initialZoom = 3 }: GeocoderRuntimeOptions
): GeocoderRuntimeHandle {
	const mapStyle = useEarthMapStyle(config)
	const overlays = useEarthOverlays(config)
	const geoBias = useGeoBias()
	const [engine, setEngine] = useState<EngineStamp | null>(null)

	const runParseWithBias = useCallback(
		async (input: string, viewport: MapBias | null, hooks: { onStage: (stage: number) => void }) => {
			const bias: GeocodeBiasPoint[] = []

			if (viewport) {
				bias.push({ lat: viewport.center[1], lon: viewport.center[0], weight: VIEWPORT_BIAS_WEIGHT })
			}

			if (geoBias.locationRef.current) {
				bias.push({ ...geoBias.locationRef.current, weight: DEVICE_LOCATION_BIAS_WEIGHT })
			}

			const { result, engine: stamp } = await remoteGeocode(apiURL, input, bias, hooks)

			setEngine(stamp)

			return result
		},
		[apiURL, geoBias.locationRef]
	)

	const runParse = useCallback(
		(input: string, hooks: { onStage: (stage: number) => void }) => runParseWithBias(input, null, hooks),
		[runParseWithBias]
	)

	const runtime = useMemo<GeocoderRuntime>(
		() => ({
			ready: true,
			runParse,
			runParseWithBias,
			autocomplete: noRemoteSuggestions,
			parseStageLabels: REMOTE_PARSE_STAGE_LABELS,
			loading: null,
			errorMessage: null,
			mapStyle,
			overlays,
			initialCenter: [initialCenter[0], initialCenter[1]],
			initialZoom,
			calibrator: null,
			resolveMapPlace,
			activeBackend: engine ? `${apiURL.host} (mailwoman ${engine.version})` : apiURL.host,
		}),
		[apiURL, engine, initialCenter, initialZoom, mapStyle, overlays, runParse, runParseWithBias]
	)

	return {
		runtime,
		releases: [],
		geoBias: { active: geoBias.active, error: geoBias.error, toggle: geoBias.toggle },
		calibrator: null,
		traceParse: async () => null,
		supportsTrace: false,
	}
}
