/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders a selector for the available model versions. The host owns loading and selection.
 */

import type { ReactNode } from "react"

import type { VersionOption } from "#map/types"

/**
 * Props for {@link VersionPicker}.
 */
export interface VersionPickerProps {
	versions: ReadonlyArray<VersionOption>
	selected: string | null
	onSelect: (version: string) => void
	/**
	 * Disables the control, for example while a parse runs.
	 */
	disabled?: boolean
	/**
	 * @default "Model version"
	 */
	label?: string
}

/**
 * Renders the model version selector, or `null` when fewer than two versions exist.
 */
export function VersionPicker({
	versions,
	selected,
	onSelect,
	disabled,
	label = "Model version",
}: VersionPickerProps): ReactNode {
	if (versions.length < 2) return null

	return (
		<div className="mw-demo-control">
			<label className="mw-demo-control__label" htmlFor="mw-demo-version">
				{label}
			</label>
			<select
				id="mw-demo-version"
				className="mw-demo-control__select"
				value={selected ?? ""}
				onChange={(e) => onSelect(e.target.value)}
				disabled={disabled}
				// The title shows the full label.
				// The field may clip it.
				title={versions.find((v) => v.version === selected)?.label ?? selected ?? undefined}
			>
				{versions.map((v) => (
					<option key={v.version} value={v.version}>
						{v.label ?? v.version}
					</option>
				))}
			</select>
		</div>
	)
}
