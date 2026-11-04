// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The sheet owns the disclosure. Groups use layer-ID patterns from the Protomaps theme and the layers Earth adds.
 *   Each group is a `<details>` element: its summary switches the whole group, and its body lists every layer
 *   with a switch of its own.
 *   A layer with no matching pattern appears in the catch-all "Other" group.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { MapInstance } from "react-map-gl/maplibre"

import styles from "./styles.module.css"

/**
 * The groups, matched against a layer ID's last `/` segment, so `planet.v4/crosswalks`
 * matches as `crosswalks`.
 *
 * Order matters: first match wins, so labels go first or road-label / earth-label /
 * address-label get pulled into the Roads / Landuse buckets.
 */
const LAYER_GROUP_PATTERNS: ReadonlyArray<{ name: string; match: RegExp }> = [
	{ name: "Labels", match: /(?:_label|^places_|^address_label|^country)/ },
	{ name: "Background", match: /^(?:background|mw-graticule)/ },
	{ name: "Ocean", match: /^(?:ocean-|land-underlay)/ },
	{ name: "Roads", match: /^(?:roads_|bridges_|tunnel_|oneway-arrows)/ },
	{ name: "Street furniture", match: /^(?:crosswalks|bike-lanes|infrastructure-)/ },
	{ name: "Trees", match: /^tree-/ },
	{ name: "Buildings", match: /^(?:buildings|basemap-buildings)/ },
	{ name: "Boundaries", match: /^boundaries/ },
	{ name: "Water", match: /^(?:water|.*water-outline)/ },
	{ name: "Landuse / parks", match: /^(?:landuse_|landcover|earth|park)/ },
	{ name: "POI symbols", match: /^pois?(?:_|$)/ },
	{ name: "Hillshade", match: /^(?:hillshade|hills$)/ },
	{ name: "TIGER (tracts)", match: /^tiger-tracts/ },
	{ name: "TIGER (blocks)", match: /^tiger-blocks/ },
	// Two separate groups so each fog reading gets its own checkbox.
	{ name: "Coverage · optimistic fog", match: /^coverage-opt/ },
	{ name: "Coverage · measured fog", match: /^coverage-honest/ },
	// Each jurisdiction measure gets its own group, and the jurisdiction borders get one.
	{ name: "Jurisdictions · training draws", match: /^jurisdictions-draws/ },
	{ name: "Jurisdictions · eligible sources", match: /^jurisdictions-sources/ },
	{ name: "Jurisdictions · address system", match: /^jurisdictions-address-system/ },
	{ name: "Jurisdictions · address shapes", match: /^jurisdictions-shapes/ },
	{ name: "Jurisdictions · borders", match: /^jurisdictions-outline/ },
	// Per-category default-off layers, one checkbox each, so the full mosaic or a single group's geography can be shown.
	{ name: "Race · White", match: /^race-dots-white/ },
	{ name: "Race · Black", match: /^race-dots-black/ },
	{ name: "Race · Hispanic", match: /^race-dots-hispanic/ },
	{ name: "Race · Asian", match: /^race-dots-asian/ },
	{ name: "Race · Other", match: /^race-dots-other/ },
]

const OTHER_GROUP = "Other"

const ORDERED_NAMES = [...LAYER_GROUP_PATTERNS.map((pattern) => pattern.name), OTHER_GROUP]

interface LayerEntry {
	id: string
	visible: boolean
}

interface LayerGroup {
	name: string
	layers: LayerEntry[]
}

/**
 * The group a layer ID belongs to, read from the ID's last `/` segment.
 */
function groupNameOf(layerID: string): string {
	const leaf = layerID.slice(layerID.lastIndexOf("/") + 1)

	return LAYER_GROUP_PATTERNS.find((pattern) => pattern.match.test(leaf))?.name ?? OTHER_GROUP
}

/**
 * The resolver's own transient `mailwoman-*` geometry is skipped, because a visitor
 * switching it off would lose the marker for their answer.
 */
function readGroups(map: MapInstance): LayerGroup[] {
	const layers = map.getStyle()?.layers ?? []
	const buckets = new Map<string, LayerGroup>()

	for (const layer of layers) {
		if (layer.id.startsWith("mailwoman-")) continue

		const name = groupNameOf(layer.id)
		const bucket = buckets.get(name) ?? { name, layers: [] }

		// A layer states its visibility only when it opts out, so a missing value reads as visible.
		const visibility = layer.layout && "visibility" in layer.layout ? layer.layout.visibility : "visible"

		bucket.layers.push({ id: layer.id, visible: visibility !== "none" })
		buckets.set(name, bucket)
	}

	return ORDERED_NAMES.map((name) => buckets.get(name)).filter((bucket) => bucket != null)
}

/**
 * Sets the visibility of each layer and returns the IDs it changed.
 *
 * A layer can leave the style between the read and the click, so a failed write
 * skips that layer and the rest still switch.
 */
function setVisibility(map: MapInstance, layerIDs: readonly string[], visible: boolean): Set<string> {
	const changed = new Set<string>()

	for (const layerID of layerIDs) {
		try {
			map.setLayoutProperty(layerID, "visibility", visible ? "visible" : "none")
			changed.add(layerID)
		} catch {
			continue
		}
	}

	return changed
}

interface GroupCheckboxProps {
	group: LayerGroup
	onToggle: (group: LayerGroup) => void
}

/**
 * The group's own switch: checked when every layer shows, and indeterminate when only some do.
 */
function GroupCheckbox({ group, onToggle }: GroupCheckboxProps) {
	const ref = useRef<HTMLInputElement>(null)
	const shown = group.layers.filter((layer) => layer.visible).length
	const partial = shown > 0 && shown < group.layers.length

	useEffect(() => {
		if (ref.current) {
			ref.current.indeterminate = partial
		}
	}, [partial])

	return (
		<input
			ref={ref}
			type="checkbox"
			aria-label={`Show ${group.name}`}
			checked={shown === group.layers.length}
			// The checkbox sits in the `<summary>`, so a click must switch the group without opening the disclosure.
			onClick={(event) => event.stopPropagation()}
			onChange={() => onToggle(group)}
		/>
	)
}

export interface LayerToggleControlProps {
	/**
	 * The live map.
	 *
	 * `null` until react-map-gl instantiates the map.
	 * The control renders no content during that time.
	 */
	map: MapInstance | null
}

export function LayerToggleControl({ map }: LayerToggleControlProps) {
	const [groups, setGroups] = useState<LayerGroup[]>([])

	useEffect(() => {
		if (!map) return

		// `styledata` can fire before the layers are populated, so the empty answer
		// is refused and `idle` is subscribed too.
		const sync = () => {
			if (!map.isStyleLoaded()) return

			const next = readGroups(map)

			if (next.length) {
				setGroups(next)
			}
		}

		map.on("styledata", sync)
		map.on("idle", sync)
		// An already-idle map sends no event, so `triggerRepaint()` produces the `idle`
		// that reads the first groups rather than writing during the effect.
		map.triggerRepaint()

		return () => {
			map.off("styledata", sync)
			map.off("idle", sync)
		}
	}, [map])

	const apply = useCallback(
		(layerIDs: readonly string[], visible: boolean) => {
			if (!map) return

			const changed = setVisibility(map, layerIDs, visible)

			setGroups((current) =>
				current.map((group) => ({
					...group,
					layers: group.layers.map((layer) => (changed.has(layer.id) ? { ...layer, visible } : layer)),
				}))
			)
		},
		[map]
	)

	// A group that shows any layer switches every layer off.
	// A group with every layer hidden switches them all on.
	const toggleGroup = useCallback(
		(group: LayerGroup) =>
			apply(
				group.layers.map((layer) => layer.id),
				!group.layers.some((layer) => layer.visible)
			),
		[apply]
	)

	if (!map) return null

	return (
		<div className={styles.layerTogglePanel}>
			<p className="mw-map-sheet__hint">
				Groups of the basemap's layers. A group's switch shows or hides every layer in it; open the group to switch one
				layer. The resolver's own marker and outline are not listed, because losing them would lose the answer.
			</p>

			{groups.map((group) => (
				<details key={group.name} className={styles.layerGroup}>
					<summary className={styles.layerToggleRow}>
						<GroupCheckbox group={group} onToggle={toggleGroup} />
						<span className={styles.layerToggleLabel}>{group.name}</span>
						<span className={styles.layerToggleCount}>{group.layers.length}</span>
					</summary>

					<div className={styles.layerList}>
						{group.layers.map((layer) => (
							<label key={layer.id} className={styles.layerToggleRow}>
								<input type="checkbox" checked={layer.visible} onChange={() => apply([layer.id], !layer.visible)} />
								<span className={styles.layerID}>{layer.id}</span>
							</label>
						))}
					</div>
				</details>
			))}
		</div>
	)
}
