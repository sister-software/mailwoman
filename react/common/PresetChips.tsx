/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `PresetChips` — the "Try:" row of example buttons shared by both explorers. Presentational: it
 *   renders a labelled list and calls `onPick` with the chosen preset's value.
 */

import type { ReactNode } from "react"

export interface Preset {
	label: string
	value: string
}

export interface PresetChipsProps {
	presets: ReadonlyArray<Preset>
	onPick: (value: string) => void
	disabled?: boolean
	/** Leading label. @default "Try:" */
	caption?: string
}

export function PresetChips({ presets, onPick, disabled, caption = "Try:" }: PresetChipsProps): ReactNode {
	return (
		<div className="mw-presets">
			<span className="mw-presets__label">{caption}</span>
			{presets.map((preset) => (
				<button
					key={preset.label}
					type="button"
					className="mw-chip"
					disabled={disabled}
					onClick={() => onPick(preset.value)}
					title={preset.value}
				>
					{preset.label}
				</button>
			))}
		</div>
	)
}
