/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapControlStack>` — the column of map controls down one edge, and `<MapControlButton>`, the control inside it.
 *
 *   Controls sit in GROUPS: a group is one glass capsule with hairlines between its buttons, and separate groups are
 *   separate capsules with a gap. That grouping is the whole layout idea — related controls read as one object, and
 *   an unrelated one (a compass that comes and goes) does not join a capsule it would resize.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"

export interface MapControlButtonProps {
	/**
	 * The mark inside the control — an SVG icon or a single glyph.
	 */
	children: ReactNode
	/**
	 * The control's accessible name. Required: the visible content is a mark, not a word.
	 */
	label: string
	onPress: () => void
	/**
	 * Reads as active, for a control that toggles a layer or a mode.
	 */
	active?: boolean
	disabled?: boolean
	className?: string
}

export function MapControlButton({
	children,
	label,
	onPress,
	active,
	disabled,
	className,
}: MapControlButtonProps): ReactNode {
	return (
		<button
			type="button"
			className={cx("mw-map-control", active && "mw-map-control--active", className)}
			aria-label={label}
			aria-pressed={active}
			title={label}
			disabled={disabled}
			onClick={onPress}
		>
			{children}
		</button>
	)
}

export interface MapControlGroupProps {
	children: ReactNode
	className?: string
}

/**
 * One capsule. Put related controls in the same group; give an unrelated one its own.
 */
export function MapControlGroup({ children, className }: MapControlGroupProps): ReactNode {
	return <div className={cx("mw-map-control-group", className)}>{children}</div>
}

export interface MapControlStackProps {
	/**
	 * Groups, top to bottom.
	 */
	children: ReactNode
	/**
	 * Which edge the column sits against. @default "right"
	 */
	side?: "left" | "right"
	className?: string
	/**
	 * Accessible name for the column, e.g. "Map controls".
	 */
	label?: string
}

export function MapControlStack({ children, side = "right", className, label }: MapControlStackProps): ReactNode {
	return (
		<div
			className={cx("mw-map-control-stack", `mw-map-control-stack--${side}`, className)}
			role="group"
			aria-label={label}
		>
			{children}
		</div>
	)
}
