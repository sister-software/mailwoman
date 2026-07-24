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
	/**
	 * ISO country code for the placetype-pair country pin (#1278 phase 2's `{country}` override). Optional: a host that
	 * wires the pair prior hands this to `selectPairIndexForText` when the input still equals this preset's text, so a
	 * locale structural routing can't detect (NZ's 4-digit postcode isn't distinctive) still fires the dependent_locality
	 * prior. Purely descriptive to `PresetChips` itself (which only emits `value`).
	 */
	country?: string
}

export interface PresetChipsProps {
	presets: ReadonlyArray<Preset>
	onPick: (value: string) => void
	disabled?: boolean
	/** Leading label. @default "Try:" */
	caption?: string
	/** Optional trailing content rendered inside the chip row after the presets (e.g. an inline permalink button). */
	trailing?: ReactNode
}

export function PresetChips({ presets, onPick, disabled, caption = "Try:", trailing }: PresetChipsProps): ReactNode {
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
			{trailing}
		</div>
	)
}
