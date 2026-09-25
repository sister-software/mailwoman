/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Presentational selector for available model versions.
 *   The host owns loading and selection state; fewer than two versions renders nothing.
 */

import type { ReactNode } from "react"

import type { VersionOption } from "#map/types"

export interface VersionPickerProps {
	/**
	 * The selectable model bundles.
	 */
	versions: ReadonlyArray<VersionOption>
	/**
	 * The currently-selected version tag.
	 */
	selected: string | null
	/**
	 * Fired with the chosen version tag.
	 */
	onSelect: (version: string) => void
	/**
	 * Disable the control (e.g. While a parse is running).
	 */
	disabled?: boolean
	/**
	 * Field label. @default "Model version"
	 */
	label?: string
}

/**
 * The model-version selector.
 *
 * Renders `null` when there is nothing meaningful to pick.
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
				// The field clips a long release label.
				// This is where the whole of it stays reachable.
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
