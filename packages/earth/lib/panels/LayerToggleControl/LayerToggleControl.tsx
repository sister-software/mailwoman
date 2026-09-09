/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The layer control: a disclosure button in the map chrome's top column that opens per-group visibility checkboxes.
 *
 *   Useful while debugging cartography — the protomaps basemap stacks ~70 layers, many of which (POI labels,
 *   hillshade, building outlines) get in the way of seeing what's underneath. It is collapsed until asked for, because
 *   seventeen groups open by default covered a quarter of the map for every visitor who did not want them.
 *
 *   Groups come from the layer-ID prefix the protomaps theme uses (`roads_*`, `places_*`, `landuse_*`, `buildings_*`,
 *   `boundaries`, …), so the control adapts to whatever layers the current style carries. A layer no pattern matches
 *   falls into a catch-all "Other" group rather than disappearing.
 */

import { useCallback, useEffect, useState } from "react"
import type { MapInstance } from "react-map-gl/maplibre"

import styles from "./styles.module.css"

// Order matters: first match wins. Labels go first so road-label / earth-label / address-label
// don't get pulled into the Roads / Landuse buckets.
/**
 * Patterns grouping map layers into the toggles shown in the control, so related layers switch together.
 */
const LAYER_GROUP_PATTERNS: ReadonlyArray<{ name: string; match: RegExp }> = [
	{ name: "Labels", match: /(?:_label|^places_|^address_label|^country)/ },
	{ name: "Background", match: /^background/ },
	{ name: "Roads", match: /^(?:roads_|bridges_|tunnel_)/ },
	{ name: "Buildings", match: /^(?:buildings|basemap-buildings)/ },
	{ name: "Boundaries", match: /^boundaries/ },
	{ name: "Water", match: /^(?:water|.*water-outline)/ },
	{ name: "Landuse / parks", match: /^(?:landuse_|landcover_|earth|park)/ },
	{ name: "POI symbols", match: /^pois?_/ },
	{ name: "Hillshade", match: /^hillshade(?:\/|$|-)/ },
	{ name: "TIGER (tracts)", match: /^tiger-tracts/ },
	{ name: "TIGER (blocks)", match: /^tiger-blocks/ },
	// Address-coverage fog overlay (#coverage). Two separate groups so each fog reading gets its own
	// checkbox — turn on "optimistic" (looks covered, reveals gaps on zoom) OR the measured fraction.
	{ name: "Coverage · optimistic fog", match: /^coverage-opt/ },
	{ name: "Coverage · measured fog", match: /^coverage-honest/ },
	// Race-by-dot-density overlay (#race-dots). Per-category default-off layers → one checkbox each, so
	// you can show the full mosaic or isolate a single group's geography.
	{ name: "Race · White", match: /^race-dots-white/ },
	{ name: "Race · Black", match: /^race-dots-black/ },
	{ name: "Race · Hispanic", match: /^race-dots-hispanic/ },
	{ name: "Race · Asian", match: /^race-dots-asian/ },
	{ name: "Race · Other", match: /^race-dots-other/ },
]

const ORDERED_NAMES = [...LAYER_GROUP_PATTERNS.map((pattern) => pattern.name), "Other"]

interface LayerGroup {
	name: string
	layerIDs: string[]
	visible: boolean
}

/**
 * Bucket the style's layers by prefix. The resolver's own output (`mailwoman-*`) is skipped: it is transient result
 * geometry rather than part of the basemap, and a visitor switching it off would lose the marker for their answer.
 */
function readGroups(map: MapInstance): LayerGroup[] {
	const layers = map.getStyle()?.layers ?? []
	const buckets = new Map<string, LayerGroup>()

	for (const layer of layers) {
		if (layer.id.startsWith("mailwoman-")) continue

		const name = LAYER_GROUP_PATTERNS.find((pattern) => pattern.match.test(layer.id))?.name ?? "Other"
		const bucket = buckets.get(name) ?? { name, layerIDs: [], visible: false }

		bucket.layerIDs.push(layer.id)

		// A group reads visible when ANY of its layers is: the per-layer default is "visible", stated only when a
		// layer opts out.
		if ((layer.layout && "visibility" in layer.layout ? layer.layout.visibility : "visible") !== "none") {
			bucket.visible = true
		}

		buckets.set(name, bucket)
	}

	return ORDERED_NAMES.map((name) => buckets.get(name)).filter((bucket) => bucket !== undefined)
}

export interface LayerToggleControlProps {
	/**
	 * The live map. `null` before react-map-gl instantiates it, which is when the control renders nothing.
	 */
	map: MapInstance | null
}

export function LayerToggleControl({ map }: LayerToggleControlProps) {
	const [open, setOpen] = useState(false)
	const [groups, setGroups] = useState<LayerGroup[]>([])

	useEffect(() => {
		if (!map) return

		// `styledata` fires before the layers are populated, so a render on that alone produces zero buckets and would
		// replace a good reading with an empty one. Both events are subscribed and the empty answer is refused.
		const sync = () => {
			if (!map.isStyleLoaded()) return

			const next = readGroups(map)

			if (next.length) {
				setGroups(next)
			}
		}

		map.on("styledata", sync)
		map.on("idle", sync)
		// The map is usually already idle when this control mounts, and an idle map sends nothing. Asking for one more
		// frame produces the `idle` that reads the first set of groups, so the reading arrives from an event rather
		// than from a write during the effect.
		map.triggerRepaint()

		return () => {
			map.off("styledata", sync)
			map.off("idle", sync)
		}
	}, [map])

	const toggle = useCallback(
		(group: LayerGroup) => {
			if (!map) return

			const visibility = group.visible ? "none" : "visible"

			for (const layerID of group.layerIDs) {
				// A layer can leave the style between the read and the click; the group's other layers still switch.
				try {
					map.setLayoutProperty(layerID, "visibility", visibility)
				} catch {
					continue
				}
			}

			setGroups((current) =>
				current.map((entry) => (entry.name === group.name ? { ...entry, visible: !entry.visible } : entry))
			)
		},
		[map]
	)

	if (!map) return null

	return (
		<div className={`mw-map-layers ${styles.layerToggleCtrl}`}>
			<button
				type="button"
				className={styles.layerToggleButton}
				aria-expanded={open}
				title="Show or hide groups of basemap layers"
				onClick={() => setOpen((value) => !value)}
			>
				Layers
			</button>

			{open ? (
				<div className={styles.layerTogglePanel}>
					{groups.map((group) => (
						<label key={group.name} className={styles.layerToggleRow}>
							<input type="checkbox" checked={group.visible} onChange={() => toggle(group)} />
							<span className={styles.layerToggleLabel}>{`${group.name} (${group.layerIDs.length})`}</span>
						</label>
					))}
				</div>
			) : null}
		</div>
	)
}
