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
import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import { GeocoderService, ProviderPlacement } from "@mailwoman/geocoder-service"
import type { GeocoderRuntime, MapBias, ResolvedMapPlace, Suggestion } from "@mailwoman/react/map"
import { useConnectivity } from "@mailwoman/react/network/ReachabilityProvider"
import { parsePointQuery } from "@mailwoman/spatial/point-query"
import { useCallback, useMemo, useState } from "react"

import type { EarthConfig } from "#config"
import { openGazetteer } from "#explorers/Gazette/gazetteer"
import { pageSearchParam } from "#routes"
import { locatePointQuery, pointQueryResult } from "#runtime/point/place"
import { REMOTE_PARSE_STAGE_LABELS, remoteGeocode } from "#runtime/remote-geocoder"
import { useGeoBias } from "#runtime/use/geo-bias"
import {
	explainReadFailure,
	type GeocoderRuntimeHandle,
	type GeocoderRuntimeOptions,
	useEarthMapStyle,
	useEarthOverlays,
} from "#runtime/use/geocoder-runtime"
import { readWOFPlace } from "#runtime/wof-place"

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
 * Another lane owns the `/v1/autocomplete` route.
 *
 * That route would answer them, and this function would call it.
 */
async function noRemoteSuggestions(): Promise<Suggestion[]> {
	return []
}

interface RemoteQuery {
	input: string
	bias: GeocodeBiasPoint[]
}

interface RemoteAnswer {
	result: ParseResult
	engine: EngineStamp | null
}

/**
 * The route of the hosted API that the page's `ReachabilityProvider` probes.
 *
 * The API Worker answers it with 503 when its backend is unavailable,
 * so a failing backend reads as unreachable.
 */
export function remoteGeocoderHealthURL(apiURL: URL): URL {
	return new URL("health", apiURL)
}

/**
 * Build the {@link GeocoderRuntime} that sends each address to the hosted API at `apiURL`.
 *
 * The runtime asks a {@linkcode GeocoderService} that holds only the remote provider,
 * so a query made while the nearest `ReachabilityProvider` reads offline rejects at
 * once with a connectivity error instead of a failed fetch.
 */
export function useRemoteGeocoderRuntime(
	apiURL: URL,
	{ config, initialCenter, initialZoom = 3 }: GeocoderRuntimeOptions
): GeocoderRuntimeHandle {
	const mapStyle = useEarthMapStyle(config)
	const overlays = useEarthOverlays(config)
	const geoBias = useGeoBias()
	const [engine, setEngine] = useState<EngineStamp | null>(null)
	const { read, recheck } = useConnectivity()

	const service = useMemo(
		() =>
			new GeocoderService<RemoteQuery, RemoteAnswer>({
				remote: {
					id: apiURL.host,
					placement: ProviderPlacement.Remote,
					isReady: () => true,
					geocode: ({ input, bias }, { signal, onStage }) => remoteGeocode(apiURL, input, bias, { onStage }, signal),
				},
				connectivity: read,
				onRemoteUnavailable: recheck,
			}),
		[apiURL, read, recheck]
	)

	// A `wof:` query reads the containment chain from the browser gazetteer, opened on the first such query.
	// The hosted runtime loads no polygon file, so the reader states that the id cannot be placed.
	const readWOF = useCallback(
		async (id: number): Promise<ResolvedPlaceView> => {
			const gazetteer = await openGazetteer(config.sqliteRuntimeBaseURL)

			return (await readWOFPlace(gazetteer, id, null)).place
		},
		[config.sqliteRuntimeBaseURL]
	)

	const runParseWithBias = useCallback(
		async (input: string, viewport: MapBias | null, hooks: { onStage: (stage: number) => void }) => {
			// A point query has its own decoder, so it is answered without a request to the API.
			const point = parsePointQuery(input)

			if (point) {
				hooks.onStage(0)

				const started = performance.now()
				const place = await locatePointQuery(point, viewport, readWOF).catch(explainReadFailure)

				return pointQueryResult(input, point, place, performance.now() - started)
			}

			const bias: GeocodeBiasPoint[] = []

			if (viewport) {
				bias.push({ lat: viewport.center[1], lon: viewport.center[0], weight: VIEWPORT_BIAS_WEIGHT })
			}

			if (geoBias.locationRef.current) {
				bias.push({ ...geoBias.locationRef.current, weight: DEVICE_LOCATION_BIAS_WEIGHT })
			}

			const { answer } = await service.geocode({ input, bias }, { onStage: hooks.onStage })

			setEngine(answer.engine)

			return answer.result
		},
		[service, geoBias.locationRef, readWOF]
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
