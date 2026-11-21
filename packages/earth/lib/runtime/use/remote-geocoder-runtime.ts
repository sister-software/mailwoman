// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `useRemoteGeocoderRuntime` builds the {@link GeocoderRuntime} that parses
 *   and geocodes through the hosted native API.
 *
 *   It loads no release manifest, model, FST or gazetteer database, so the page's
 *   cold load is the basemap and the app bundle.
 */

import type { GeocodeBiasPoint } from "@mailwoman/api/operations/geocode/address"
import type { EngineStamp } from "@mailwoman/core/license"
import { offlineReason } from "@mailwoman/core/network/connectivity"
import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"
import { type GeocoderProvider, GeocoderService, ProviderPlacement } from "@mailwoman/geocoder-service"
import type { GeocoderRuntime, MapBias, ResolvedMapPlace, Suggestion } from "@mailwoman/react/map"
import { useConnectivity } from "@mailwoman/react/network/ReachabilityProvider"
import { useCallback, useEffect, useMemo, useState } from "react"

import type { EarthConfig } from "#config"
import { openGazetteer } from "#explorers/Gazette/gazetteer"
import { pageSearchParam } from "#routes"
import { BROWSER_PROVIDER_ID, type LocalFallbackQuery } from "#runtime/local-fallback"
import { locatePointQuery, pointQueryResult } from "#runtime/point/place"
import { loadPointReader } from "#runtime/point/point-reader"
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
	// runtime draws comes from the release's `wof-polygons.db`, which this runtime doesn't load.
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

/**
 * One query as both providers read it.
 *
 * The hosted API takes `bias`, and the browser pipeline takes `viewport`.
 */
export interface RemoteQuery extends LocalFallbackQuery {
	bias: GeocodeBiasPoint[]
}

/**
 * One answer from either provider.
 *
 * `engine` is the hosted engine's stamp, and `null` when the browser pipeline answered.
 */
export interface RemoteAnswer {
	result: ParseResult
	engine: EngineStamp | null
}

/**
 * The browser pipeline a hosted page falls back to.
 */
export interface LocalFallback {
	/**
	 * The provider the service asks when the hosted API cannot answer.
	 *
	 * It reports itself ready once the browser runtime has loaded its release.
	 */
	provider: GeocoderProvider<RemoteQuery, RemoteAnswer>
	/**
	 * Asks the page to mount the browser runtime.
	 *
	 * The mount starts the model download.
	 * Repeated calls are harmless.
	 */
	request: () => void
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
 * The runtime asks a {@linkcode GeocoderService} that binds the remote provider.
 * With a `fallback`, the service also binds the browser pipeline as its local provider.
 *
 * A query made while the nearest `ReachabilityProvider` reads offline skips the request.
 * It goes to the local provider when that provider is ready.
 *
 * Otherwise it rejects at once with a connectivity error instead of a failed fetch.
 *
 * The first remote failure asks the page for the browser runtime.
 * So does the first offline reading.
 *
 * The query that met the failure still rejects, because the model hasn't loaded yet.
 * A later query is answered in the browser.
 */
export function useRemoteGeocoderRuntime(
	apiURL: URL,
	{ config, initialCenter, initialZoom = 3 }: GeocoderRuntimeOptions,
	fallback: LocalFallback | null = null
): GeocoderRuntimeHandle {
	const mapStyle = useEarthMapStyle(config)
	const overlays = useEarthOverlays(config)
	const geoBias = useGeoBias()
	const [engine, setEngine] = useState<EngineStamp | null>(null)
	const [answeredInBrowser, setAnsweredInBrowser] = useState(false)
	const { reading, read, recheck } = useConnectivity()

	const service = useMemo(
		() =>
			new GeocoderService<RemoteQuery, RemoteAnswer>({
				remote: {
					id: apiURL.host,
					placement: ProviderPlacement.Remote,
					isReady: () => true,
					geocode: ({ input, bias }, { signal, onStage }) => remoteGeocode(apiURL, input, bias, { onStage }, signal),
				},
				local: fallback?.provider ?? null,
				connectivity: read,
				onRemoteUnavailable: () => {
					recheck()
					fallback?.request()
				},
			}),
		[apiURL, read, recheck, fallback]
	)

	const ruledOut = offlineReason(reading) !== null

	// The service skips the request while the reading rules it out, so it reports no remote failure then.
	useEffect(() => {
		if (ruledOut) {
			fallback?.request()
		}
	}, [ruledOut, fallback])

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
			// The reader takes trimmed text, so the typed input is trimmed here.
			const point = (await loadPointReader())(input.trim())

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

			const { answer, placement } = await service.geocode({ input, bias, viewport }, { onStage: hooks.onStage })

			setEngine(answer.engine)
			setAnsweredInBrowser(placement === ProviderPlacement.Local)

			return answer.result
		},
		[service, geoBias.locationRef, readWOF]
	)

	const runParse = useCallback(
		(input: string, hooks: { onStage: (stage: number) => void }) => runParseWithBias(input, null, hooks),
		[runParseWithBias]
	)

	const activeBackend = useMemo(() => {
		if (answeredInBrowser) return `${BROWSER_PROVIDER_ID} (${apiURL.host} did not answer)`

		return engine ? `${apiURL.host} (mailwoman ${engine.version})` : apiURL.host
	}, [answeredInBrowser, apiURL, engine])

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
			activeBackend,
		}),
		[activeBackend, initialCenter, initialZoom, mapStyle, overlays, runParse, runParseWithBias]
	)

	return {
		runtime,
		releases: [],
		geoBias: { active: geoBias.active, error: geoBias.error, toggle: geoBias.toggle },
		calibrator: null,
		traceParse: async () => null,
		supportsTrace: false,
		// The hosted geocoder loads no release in the page, so there's no ledger and no gazetteer to fail.
		gazetteerError: null,
		loadLedger: null,
		reloadStack: null,
		reloadGazetteer: null,
		reloadModel: null,
	}
}
