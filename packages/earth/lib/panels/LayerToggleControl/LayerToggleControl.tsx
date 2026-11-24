// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The sheet owns the disclosure.
 *
 *   The panel lists the groups and switches of `@mailwoman/cartographer/layer-toggles`.
 *   Each group is a `<details>` element: its summary switches the group,
 *   and its body lists each switch of the group by its label.
 *
 *   A switch owns every style layer the table places under it, so one switch shows
 *   a road's lines, casings and bridges together.
 *
 *   A switch turned on restores each of its layers to the visibility the style first
 *   gave it, so a casing the theme hides stays hidden.
 *   Only when the style hid every layer of the switch does turning it on show them all.
 */

import {
	LAYER_TOGGLE_GROUPS,
	type LayerToggleDeclaration,
	resolveLayerToggle,
} from "@mailwoman/cartographer/layer-toggles"
import { useCallback, useEffect, useRef, useState } from "react"
import type { MapInstance } from "react-map-gl/maplibre"

import styles from "./styles.module.css"

interface ToggleState extends LayerToggleDeclaration {
	layerIDs: string[]
	visible: boolean
}

interface GroupState {
	key: string
	label: string
	toggles: ToggleState[]
}

/**
 * Each layer's visibility when the panel first read it, by layer ID.
 */
type DefaultVisibility = Map<string, boolean>

function layerShown(layer: { layout?: unknown }): boolean {
	const layout = layer.layout as { visibility?: string } | undefined

	// A layer states its visibility only when it opts out, so a missing value reads as visible.
	return layout?.visibility !== "none"
}

/**
 * The resolver's own transient `mailwoman-*` geometry is skipped, because a visitor
 * switching it off would lose the marker for their answer.
 */
function readGroups(map: MapInstance, defaults: DefaultVisibility, unplaced: Set<string>): GroupState[] {
	const toggles = new Map<string, ToggleState>()

	for (const layer of map.getStyle()?.layers ?? []) {
		if (layer.id.startsWith("mailwoman-")) continue

		const toggle = resolveLayerToggle(layer)

		if (toggle === "canvas") continue

		if (toggle === null) {
			if (!unplaced.has(layer.id)) {
				unplaced.add(layer.id)

				console.warn(`[mailwoman earth] layer ${layer.id} has no switch in the layer table`)
			}

			continue
		}

		const shown = layerShown(layer)

		if (!defaults.has(layer.id)) {
			defaults.set(layer.id, shown)
		}

		const state = toggles.get(toggle.key) ?? { ...toggle, layerIDs: [], visible: false }

		state.layerIDs.push(layer.id)
		state.visible ||= shown
		toggles.set(toggle.key, state)
	}

	return LAYER_TOGGLE_GROUPS.map((group) => {
		const declaredOrder = group.toggles.map((toggle) => toggle.key)

		const members = [...toggles.values()]
			.filter((toggle) => toggle.group === group.key)
			.toSorted((a, b) => rank(declaredOrder, a.key) - rank(declaredOrder, b.key))

		return { key: group.key, label: group.label, toggles: members }
	}).filter((group) => group.toggles.length > 0)
}

/**
 * A declared switch's position in its group, with every switch declared in
 * layer metadata after them in style order.
 */
function rank(order: readonly string[], key: string): number {
	const index = order.indexOf(key)

	return index === -1 ? order.length : index
}

/**
 * Sets the visibility of each layer.
 *
 * A layer can leave the style between the read and the click, so a failed write
 * skips that layer and the rest still switch.
 */
function setVisibility(map: MapInstance, layerIDs: readonly string[], visible: boolean): void {
	for (const layerID of layerIDs) {
		try {
			map.setLayoutProperty(layerID, "visibility", visible ? "visible" : "none")
		} catch {
			continue
		}
	}
}

/**
 * Shows or hides one switch, with the exclusive set and the replaced basemap layers that follow from it.
 */
function applyToggle(
	map: MapInstance,
	groups: readonly GroupState[],
	toggle: ToggleState,
	visible: boolean,
	defaults: DefaultVisibility
): void {
	if (!visible) {
		setVisibility(map, toggle.layerIDs, false)
		setVisibility(map, toggle.replaces ?? [], true)

		return
	}

	if (toggle.exclusive) {
		for (const other of groups.flatMap((group) => group.toggles)) {
			if (other.exclusive === toggle.exclusive && other.key !== toggle.key) {
				setVisibility(map, other.layerIDs, false)
			}
		}
	}

	const shownByDefault = toggle.layerIDs.filter((layerID) => defaults.get(layerID) === true)

	setVisibility(map, toggle.layerIDs, false)
	setVisibility(map, shownByDefault.length ? shownByDefault : toggle.layerIDs, true)
	setVisibility(map, toggle.replaces ?? [], false)
}

interface GroupCheckboxProps {
	group: GroupState
	onToggle: (group: GroupState) => void
}

/**
 * The group's own switch: checked when every switch the group shows by default is on,
 * and indeterminate when some other combination is.
 */
function GroupCheckbox({ group, onToggle }: GroupCheckboxProps) {
	const ref = useRef<HTMLInputElement>(null)
	const shown = group.toggles.filter((toggle) => toggle.visible)
	const defaults = group.toggles.filter((toggle) => toggle.groupDefault !== false)
	const checked = shown.length > 0 && defaults.every((toggle) => toggle.visible)
	const partial = shown.length > 0 && !checked

	useEffect(() => {
		if (ref.current) {
			ref.current.indeterminate = partial
		}
	}, [partial])

	return (
		<input
			ref={ref}
			type="checkbox"
			aria-label={`Show ${group.label}`}
			checked={checked}
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
	const [groups, setGroups] = useState<GroupState[]>([])
	const defaults = useRef<DefaultVisibility>(new Map())
	const unplaced = useRef(new Set<string>())

	const read = useCallback(() => {
		if (!map) return

		const next = readGroups(map, defaults.current, unplaced.current)

		if (next.length) {
			setGroups(next)
		}
	}, [map])

	// An event can arrive before the style's layers exist.
	// After the panel's own write, `isStyleLoaded()` is false while the shown layers fetch tiles,
	// yet `getStyle()` already holds the new visibility, so a write reads directly.
	const refresh = useCallback(() => {
		if (map?.isStyleLoaded()) {
			read()
		}
	}, [map, read])

	useEffect(() => {
		if (!map) return

		// `styledata` can fire before the layers are populated, so the empty answer
		// is refused and `idle` is subscribed too.
		map.on("styledata", refresh)
		map.on("idle", refresh)
		// An already-idle map sends no event, so `triggerRepaint()` produces the `idle`
		// that reads the first groups rather than writing during the effect.
		map.triggerRepaint()

		return () => {
			map.off("styledata", refresh)
			map.off("idle", refresh)
		}
	}, [map, refresh])

	const toggleOne = useCallback(
		(toggle: ToggleState) => {
			if (!map) return

			applyToggle(map, groups, toggle, !toggle.visible, defaults.current)
			read()
		},
		[map, groups, read]
	)

	// A group that shows any switch hides every switch.
	// A group showing none shows its default switches, or its first switch when it has none,
	// as the data overlays do before any is chosen.
	const toggleGroup = useCallback(
		(group: GroupState) => {
			if (!map) return

			if (group.toggles.some((toggle) => toggle.visible)) {
				for (const toggle of group.toggles) {
					applyToggle(map, groups, toggle, false, defaults.current)
				}
			} else {
				const chosen = group.toggles.filter((toggle) => toggle.groupDefault !== false)

				for (const toggle of chosen.length ? chosen : group.toggles.slice(0, 1)) {
					applyToggle(map, groups, toggle, true, defaults.current)
				}
			}

			read()
		},
		[map, groups, read]
	)

	if (!map) return null

	return (
		<div className={styles.layerTogglePanel}>
			<p className="mw-map-sheet__hint">
				A group's switch shows or hides the group; open it to switch one kind of feature. A Who's On First switch draws
				its places' names in place of the basemap's, so each name shows once. The resolver's own marker and outline are
				not listed, because losing them would lose the answer.
			</p>

			{groups.map((group) => (
				<details key={group.key} className={styles.layerGroup}>
					<summary className={styles.layerToggleRow}>
						<GroupCheckbox group={group} onToggle={toggleGroup} />
						<span className={styles.layerToggleLabel}>{group.label}</span>
						<span className={styles.layerToggleCount}>
							{group.toggles.filter((toggle) => toggle.visible).length}/{group.toggles.length}
						</span>
					</summary>

					<div className={styles.layerList}>
						{group.toggles.map((toggle) => (
							<label key={toggle.key} className={styles.layerToggleRow}>
								<input
									type={toggle.exclusive ? "radio" : "checkbox"}
									name={toggle.exclusive}
									checked={toggle.visible}
									// A radio button sends no change when clicked while checked, so a click reads the click.
									onClick={toggle.exclusive ? () => toggleOne(toggle) : undefined}
									onChange={toggle.exclusive ? () => undefined : () => toggleOne(toggle)}
								/>
								<span className={styles.layerToggleLabel}>{toggle.label}</span>
							</label>
						))}
					</div>
				</details>
			))}
		</div>
	)
}
