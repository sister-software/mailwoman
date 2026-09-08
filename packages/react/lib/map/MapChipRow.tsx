/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapChipRow>` — the row of example queries under a search bar.
 *
 *   It SCROLLS horizontally and never wraps. Earth's twelve examples wrapped down five ragged rows (3/3/2/1/1/1) and
 *   took a third of the panel; one scrolling line is the shape the reference map apps use, and it costs a fixed
 *   height whatever the number of examples.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"

export interface MapChip {
	/**
	 * What the chip reads.
	 */
	label: string
	/**
	 * The query the chip stands for, handed back on press. Defaults to the label.
	 */
	value?: string
	/**
	 * Rendered before the label — a category mark.
	 */
	icon?: ReactNode
}

export interface MapChipRowProps {
	chips: MapChip[]
	/**
	 * Fired with the chip's `value` (or its label) when one is pressed.
	 */
	onPick: (value: string) => void
	/**
	 * The chip matching this value reads as pressed.
	 */
	activeValue?: string
	disabled?: boolean
	className?: string
	/**
	 * Accessible name for the row, e.g. "Example addresses".
	 */
	label?: string
}

export function MapChipRow({ chips, onPick, activeValue, disabled, className, label }: MapChipRowProps): ReactNode {
	if (!chips.length) return null

	return (
		<div className={cx("mw-map-chiprow", className)} role="group" aria-label={label}>
			{chips.map((chip) => {
				const value = chip.value ?? chip.label
				const active = value === activeValue

				return (
					<button
						key={value}
						type="button"
						className={cx("mw-map-chip", active && "mw-map-chip--active")}
						aria-pressed={active}
						disabled={disabled}
						onClick={() => onPick(value)}
					>
						{chip.icon ? <span className="mw-map-chip__icon">{chip.icon}</span> : null}
						{chip.label}
					</button>
				)
			})}
		</div>
	)
}
