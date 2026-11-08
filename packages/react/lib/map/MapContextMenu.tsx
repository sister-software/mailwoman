// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The map's right-click menu: a glass panel at the pointer with rows the host supplies, each a label,
 *   a value and a copy button, and actions beneath them. {@link useMapContextMenu} reads the map's
 *   `contextmenu` event and closes the menu when the map moves. The menu itself closes on Escape and on a
 *   pointer press outside it, as the footer's sources popover does.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import type { MapInstance, MapLayerMouseEvent } from "react-map-gl/maplibre"

import { cx } from "#common/cx"
import type { LngLat } from "#map/place-render"

import { CopyButton } from "../common/CopyButton.tsx"

/**
 * Where the menu opened: the point under the pointer and its place on the map container.
 */
export interface MapContextMenuPoint {
	lngLat: LngLat
	zoom: number
	/**
	 * The pointer's position in the map container, in CSS pixels.
	 */
	x: number
	y: number
	/**
	 * The map container's size when the menu opened, so the menu can open toward the inside.
	 */
	width: number
	height: number
}

/**
 * The open menu's point and a way to close it.
 */
export interface UseMapContextMenu {
	point: MapContextMenuPoint | null
	close: () => void
}

/**
 * Opens the menu on the map's `contextmenu` event and closes it when the map starts to move.
 */
export function useMapContextMenu(map: MapInstance | null): UseMapContextMenu {
	const [point, setPoint] = useState<MapContextMenuPoint | null>(null)

	useEffect(() => {
		if (!map) return

		const onContextMenu = (event: MapLayerMouseEvent) => {
			event.preventDefault()

			const container = map.getContainer()
			const lngLat = event.lngLat.wrap()

			setPoint({
				lngLat: [lngLat.lng, lngLat.lat],
				zoom: map.getZoom(),
				x: event.point.x,
				y: event.point.y,
				width: container.clientWidth,
				height: container.clientHeight,
			})
		}

		const close = () => setPoint(null)

		map.on("contextmenu", onContextMenu)
		map.on("movestart", close)

		return () => {
			map.off("contextmenu", onContextMenu)
			map.off("movestart", close)
			setPoint(null)
		}
	}, [map])

	const close = useCallback(() => setPoint(null), [])

	return { point, close }
}

/**
 * The menu's widest and tallest extent, used to decide which side of the pointer it opens on.
 */
const MENU_WIDTH = 320
const MENU_HEIGHT = 360

export interface MapContextMenuProps {
	/**
	 * Where the menu is open, from {@link useMapContextMenu}.
	 */
	point: MapContextMenuPoint
	/**
	 * The rows and actions, such as {@link MapContextMenuRow} and {@link MapContextMenuAction}.
	 */
	children: ReactNode
	onClose: () => void
	/**
	 * The menu's accessible name.
	 *
	 * @defaultValue `"Map point"`
	 */
	label?: string
	className?: string
}

/**
 * The right-click menu, placed at its point and opened toward the inside of the map.
 */
export function MapContextMenu({ point, children, onClose, label = "Map point", className }: MapContextMenuProps) {
	const root = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) {
				onClose()
			}
		}

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose()
			}
		}

		document.addEventListener("pointerdown", onPointerDown)
		document.addEventListener("keydown", onKeyDown)

		return () => {
			document.removeEventListener("pointerdown", onPointerDown)
			document.removeEventListener("keydown", onKeyDown)
		}
	}, [onClose])

	const flipX = point.x + MENU_WIDTH > point.width
	const flipY = point.y + MENU_HEIGHT > point.height

	return (
		<div
			ref={root}
			className={cx("mw-map-menu", className)}
			role="menu"
			aria-label={label}
			style={{
				left: point.x,
				top: point.y,
				transform: `translate(${flipX ? "calc(-100% - 4px)" : "4px"}, ${flipY ? "calc(-100% - 4px)" : "4px"})`,
			}}
		>
			{children}
		</div>
	)
}

export interface MapContextMenuRowProps {
	/**
	 * What the value is, such as `Plus code`.
	 */
	label: string
	/**
	 * The value, shown in monospace and copied by the row's button.
	 */
	value: string
	/**
	 * What the label stands for, shown on hover, such as `Open Location Code`.
	 */
	hint?: string
}

/**
 * One row of the menu: a label, its value and a button that copies the value.
 */
export function MapContextMenuRow({ label, value, hint }: MapContextMenuRowProps): ReactNode {
	return (
		<div className="mw-map-menu__row" role="menuitem">
			<span className="mw-map-menu__label" title={hint}>
				{label}
			</span>
			<code className="mw-map-menu__value">{value}</code>
			<CopyButton value={value} label="Copy" copiedLabel="Copied" className="mw-map-menu__copy" />
		</div>
	)
}

export interface MapContextMenuActionProps {
	children: ReactNode
	onSelect: () => void
}

/**
 * One action of the menu, a full-width button beneath the rows.
 */
export function MapContextMenuAction({ children, onSelect }: MapContextMenuActionProps): ReactNode {
	return (
		<button type="button" className="mw-map-menu__action" role="menuitem" onClick={onSelect}>
			{children}
		</button>
	)
}
