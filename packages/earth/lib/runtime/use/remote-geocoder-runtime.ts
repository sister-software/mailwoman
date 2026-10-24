/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useRemoteGeocoderRuntime` builds the {@link GeocoderRuntime} that parses and geocodes through the hosted
 *   native API. It loads no release manifest, model, FST or gazetteer database, so the page's cold load is the
 *   basemap and the app bundle.
 */

import type { EngineStamp } from "@mailwoman/core/license"
import type { ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import type { GeocoderRuntime, ResolvedMapPlace } from "@mailwoman/react/map"
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

function resolveMapPlace(candidate: ResolvedPlaceView): ResolvedMapPlace {
	return { ...candidate }
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

	const runParse = useCallback(
		async (input: string, hooks: { onStage: (stage: number) => void }) => {
			const { result, engine: stamp } = await remoteGeocode(apiURL, input, hooks)

			setEngine(stamp)

			return result
		},
		[apiURL]
	)

	const runtime = useMemo<GeocoderRuntime>(
		() => ({
			ready: true,
			runParse,
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
		[apiURL, engine, initialCenter, initialZoom, mapStyle, overlays, runParse]
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
