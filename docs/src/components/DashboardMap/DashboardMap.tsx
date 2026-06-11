/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import "./styles.css"

import {
	fetchTileSetSources,
	MailwomanBaseTileSetID,
	StyleSpecificationComposer,
	TIGERBlocksTileSetID,
	TIGERLayers,
	TIGERTractsTileSetID,
	TileSetSourceID,
	TileSetSourceRecord,
} from "@mailwoman/cartographer"
import "maplibre-gl/dist/maplibre-gl.css"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Map, MapRef, NavigationControl, ViewStateChangeEvent } from "react-map-gl/maplibre"
import { useWebviewContext } from "../../contexts/WebviewContext.tsx"
import { SplashScreen } from "../SplashScreen/index.tsx"
import { DebugControl } from "./DebugControl.tsx"
import { GeoJSONClipboardLayer } from "./GeoJSONClipboardLayer.tsx"

const tileSetSourceIDs: TileSetSourceID[] = [MailwomanBaseTileSetID, TIGERBlocksTileSetID, TIGERTractsTileSetID]

const DashboardMap: React.FC = () => {
	const { persistWebviewState, initialWebviewState } = useWebviewContext()

	const [tileSetSources, setTileSetSources] = useState<TileSetSourceRecord | null>(null)

	const styleSpec = useMemo(() => {
		if (!tileSetSources) return null

		const styleComposer = new StyleSpecificationComposer({
			sources: tileSetSources,
			layers: [...TIGERLayers],
		})

		return styleComposer.toJSON()
	}, [tileSetSources])

	const persistenceFrameRef = useRef<number>(-1)

	const handleViewStateChange = useCallback(
		(event: ViewStateChangeEvent) => {
			self.clearTimeout(persistenceFrameRef.current)
			persistenceFrameRef.current = self.setTimeout(() => {
				persistWebviewState((currentWebViewState) => ({
					...currentWebViewState,
					mapView: event.viewState,
				}))
			}, 500)
		},
		[persistWebviewState]
	)

	useEffect(() => {
		fetchTileSetSources(tileSetSourceIDs).then((nextTileSources) => {
			setTileSetSources(nextTileSources)
		})
	}, [])

	if (!styleSpec) {
		return <SplashScreen>Loading map...</SplashScreen>
	}

	return (
		<div className="map-container">
			<Map
				initialViewState={initialWebviewState.mapView}
				onMove={handleViewStateChange}
				maplibreLogo={false}
				mapStyle={styleSpec}
				attributionControl={{ compact: true }}
				minZoom={3}
				maxPitch={85}
				ref={exposeMapRef}
				projection="globe"
			>
				<NavigationControl position="top-left" showCompass={true} showZoom={false} visualizePitch={true} />
				<GeoJSONClipboardLayer />
				<DebugControl />
			</Map>
		</div>
	)
}

function exposeMapRef(ref: MapRef) {
	Object.assign(window, { map: ref })
}

export default memo(DashboardMap)
