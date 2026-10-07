/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<JurisdictionInspector>` draws the legend of whichever jurisdiction fill is switched on, and a card
 *   with the hovered jurisdiction's measures. It renders inside the map container, so both position
 *   against the map rather than the page.
 */

import { addressSystemColor, JurisdictionLayerID, JurisdictionLegends } from "@mailwoman/cartographer/jurisdictions"
import type { MapGeoJSONFeature, MapLayerMouseEvent, Map as MapLibreMap } from "maplibre-gl"
import { type ReactNode, useEffect, useState } from "react"

import styles from "./jurisdiction-inspector.module.css"

/**
 * The jurisdiction fills, in the order the inspector looks for a visible one.
 */
const FILL_IDS = [
	JurisdictionLayerID.draws,
	JurisdictionLayerID.sources,
	JurisdictionLayerID.addressSystem,
	JurisdictionLayerID.shapes,
] as const

/**
 * Returns the first jurisdiction fill whose visibility is on, or `undefined` when all are off.
 */
function visibleFill(map: MapLibreMap): string | undefined {
	return FILL_IDS.find((id) => map.getLayer(id) !== undefined && map.getLayoutProperty(id, "visibility") !== "none")
}

const percent = (value: unknown): string =>
	typeof value === "number" ? `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : "—"

const count = (value: unknown): string => (typeof value === "number" ? value.toLocaleString() : "—")

interface Hover {
	properties: MapGeoJSONFeature["properties"]
	x: number
	y: number
	/**
	 * Whether the card opens to the left of, or above, the cursor, because it
	 * would overflow the map on the usual side.
	 */
	flipX: boolean
	flipY: boolean
}

/**
 * The card's widest and tallest extent, used to decide which side of the cursor it opens on.
 */
const CARD_WIDTH = 340
const CARD_HEIGHT = 360

/**
 * The card for one hovered jurisdiction.
 */
function JurisdictionCard({ hover }: { hover: Hover }): ReactNode {
	const p = hover.properties
	const system = typeof p["address_system"] === "number" ? p["address_system"] : undefined

	return (
		<div
			className={styles.card}
			style={{
				left: hover.x,
				top: hover.y,
				transform: `translate(${hover.flipX ? "calc(-100% - 12px)" : "12px"}, ${hover.flipY ? "calc(-100% - 12px)" : "12px"})`,
			}}
		>
			<h3>
				{String(p["name"])} ({String(p["iso2"])})
			</h3>
			<dl>
				<dt>Training rows drawn</dt>
				<dd>
					{count(p["draws"])} ({percent(p["draw_share"])} of the run)
				</dd>
				<dt>Admitted</dt>
				<dd>{p["admitted"] ? "yes" : "no"}</dd>
				<dt>Address-shape forms</dt>
				<dd>{count(p["shape_forms"])}</dd>
				<dt>Postcode first</dt>
				<dd>{percent(p["postcode_first_share"])}</dd>
				<dt>House number first</dt>
				<dd>{percent(p["house_number_first_share"])}</dd>
				<dt>Sources</dt>
				<dd>
					{count(p["eligible_sources"])} eligible of {count(p["sources"])} (backbone {String(p["backbone"])})
				</dd>
				<dt>Board rows</dt>
				<dd>
					{count(p["board_checking_rows"])} checking of {count(p["board_rows"])}
				</dd>
				<dt>Address system</dt>
				<dd>
					{system === undefined ? (
						"no layout recorded"
					) : (
						<>
							<span
								className={styles.swatch}
								style={{ display: "inline-block", background: addressSystemColor(system) }}
							/>{" "}
							#{system} · <span className={styles.systemKey}>{String(p["address_system_key"])}</span>
						</>
					)}
				</dd>
			</dl>
		</div>
	)
}

/**
 * The legend for the visible jurisdiction fill.
 */
function JurisdictionLegend({ layerID }: { layerID: string }): ReactNode {
	const legend = JurisdictionLegends[layerID]

	if (!legend) return null

	return (
		<div className={styles.legend}>
			<h3>{legend.title}</h3>
			<ul>
				{legend.entries.map((entry) => (
					<li key={entry.label}>
						<span className={styles.swatch} style={{ background: entry.color }} />
						{entry.label}
					</li>
				))}
			</ul>
			{legend.note ? <p className={styles.note}>{legend.note}</p> : null}
		</div>
	)
}

/**
 * Tracks the visible jurisdiction fill and the hovered jurisdiction, and renders the legend and card.
 */
export function JurisdictionInspector({ map }: { map: MapLibreMap | null }): ReactNode {
	const [layerID, setLayerID] = useState<string | undefined>()
	const [hover, setHover] = useState<Hover | undefined>()

	useEffect(() => {
		if (!map) return

		// The layer toggle changes visibility through the style. That change fires `styledata`.
		const syncLayer = () => {
			const next = visibleFill(map)

			setLayerID(next)

			if (!next) {
				setHover(undefined)
			}
		}

		const onMove = (event: MapLayerMouseEvent) => {
			const active = visibleFill(map)

			if (!active) return

			const feature = map.queryRenderedFeatures(event.point, { layers: [active] })[0]

			if (!feature) {
				setHover(undefined)

				return
			}

			const container = map.getContainer()

			setHover({
				properties: feature.properties,
				x: event.point.x,
				y: event.point.y,
				flipX: event.point.x + CARD_WIDTH > container.clientWidth,
				flipY: event.point.y + CARD_HEIGHT > container.clientHeight,
			})
		}

		const onLeave = () => setHover(undefined)

		syncLayer()
		map.on("styledata", syncLayer)
		map.on("mousemove", onMove)
		map.on("mouseout", onLeave)

		return () => {
			map.off("styledata", syncLayer)
			map.off("mousemove", onMove)
			map.off("mouseout", onLeave)
		}
	}, [map])

	if (!layerID) return null

	return (
		<>
			<JurisdictionLegend layerID={layerID} />
			{hover ? <JurisdictionCard hover={hover} /> : null}
		</>
	)
}
