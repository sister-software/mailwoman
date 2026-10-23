/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The home page's full-bleed map. It flies between the tour stops, switches the labels to each stop's
 *   language, and drops a marker on the answer Earth recorded.
 *   Client-only: the home page loads it after hydration, behind a static ground of the same color.
 */

import "#shared/maplibre/worker/index"
import "maplibre-gl/dist/maplibre-gl.css"
import { MAP_FONT_ITALIC, MAP_FONT_MEDIUM, MAP_FONT_REGULAR } from "@mailwoman/cartographer/styles/fonts"
import { layers, namedFlavor } from "@protomaps/basemaps"
import type { StyleSpecification } from "maplibre-gl"
import { useEffect, useMemo, useRef, type ReactNode } from "react"
import { Map, Marker, type MapRef } from "react-map-gl/maplibre"

import type { TourStop } from "./tour.ts"

import styles from "./styles.module.css"

const SOURCE_ID = "protomaps"

/**
 * At desktop widths the hero panel covers the left of the map.
 *
 * The camera pads that side, so the marker lands in the open part.
 */
const PANEL_BREAKPOINT = 996
const PANEL_SHARE = 0.45

const cameraPadding = (width: number) => ({
	top: 0,
	bottom: 0,
	right: 0,
	left: width > PANEL_BREAKPOINT ? Math.round(width * PANEL_SHARE) : 0,
})

/**
 * Grayscale until the brand gets a light basemap of its own.
 */
const flavor = {
	...namedFlavor("grayscale"),
	regular: MAP_FONT_REGULAR,
	bold: MAP_FONT_MEDIUM,
	italic: MAP_FONT_ITALIC,
}

const composeStyle = (lang: string): StyleSpecification => ({
	version: 8,
	glyphs: "https://public.mailwoman.ai/protomaps/fonts/{fontstack}/{range}.pbf",
	sprite: "https://public.mailwoman.ai/protomaps/sprites/v4/light",
	sources: {
		[SOURCE_ID]: {
			type: "vector",
			url: "https://tiles.mailwoman.ai/planet.v4.json",
			attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
		},
	},
	layers: layers(SOURCE_ID, flavor, { lang }),
})

export interface HeroMapProps {
	stop: TourStop
	reducedMotion: boolean
}

export default function HeroMap({ stop, reducedMotion }: HeroMapProps): ReactNode {
	const mapRef = useRef<MapRef>(null)
	const mapStyle = useMemo(() => composeStyle(stop.lang), [stop.lang])

	useEffect(() => {
		const map = mapRef.current

		if (!map) return

		const camera = {
			center: [...stop.coordinates] as [number, number],
			zoom: stop.zoom,
			padding: cameraPadding(map.getContainer().clientWidth),
		}

		if (reducedMotion) {
			map.jumpTo(camera)
		} else {
			map.flyTo({ ...camera, duration: 4500, essential: false })
		}
	}, [stop, reducedMotion])

	return (
		<Map
			ref={mapRef}
			mapStyle={mapStyle}
			initialViewState={{
				longitude: stop.coordinates[0],
				latitude: stop.coordinates[1],
				zoom: stop.zoom,
				padding: cameraPadding(globalThis.innerWidth),
			}}
			interactive={false}
			attributionControl={{ compact: true }}
			style={{ position: "absolute", inset: 0 }}
		>
			<Marker key={stop.query} longitude={stop.coordinates[0]} latitude={stop.coordinates[1]} anchor="center">
				<span className={styles.marker} aria-hidden="true" />
			</Marker>
		</Map>
	)
}
