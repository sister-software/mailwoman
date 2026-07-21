/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<VersionPicker>` — the model-version `<select>` from the demo's control panel (`_app.tsx:1230-1254`),
 *   as a dumb presentational unit: the available bundles + current selection come in as props, the choice
 *   goes out through `onSelect`. No load state, no manifest fetch — the host (via `useDemoRuntime`) owns
 *   that. Renders nothing when there is fewer than two versions to choose between.
 *
 *   NODE-SAFE: pure React + a `<select>`, no maplibre. It rides the `@mailwoman/react/map` subpath only
 *   because it is a demo-specific control, not because it needs WebGL.
 */

import type { ReactNode } from "react"

import type { DemoVersionOption } from "./types.ts"

export interface VersionPickerProps {
	/** The selectable model bundles. */
	versions: ReadonlyArray<DemoVersionOption>
	/** The currently-selected version tag. */
	selected: string | null
	/** Fired with the chosen version tag. */
	onSelect: (version: string) => void
	/** Disable the control (e.g. while a parse is running). */
	disabled?: boolean
	/** Field label. @default "Model version" */
	label?: string
}

/** The model-version selector. Renders `null` when there is nothing meaningful to pick. */
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
