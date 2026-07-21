/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<CompareToggle>` — the "Compare" checkbox plus the compare-version `<select>` from the demo's
 *   control panel (`_app.tsx:1281-1339`), as a dumb presentational unit. Turning it on reveals a second
 *   version picker (the primary version filtered out); the actual second parse is a host concern the
 *   composed demo surfaces through `panels.compare`. Props in, two events out.
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import type { ReactNode } from "react"

import type { DemoVersionOption } from "./types.ts"

export interface CompareToggleProps {
	/** The selectable model bundles (the primary version is filtered out of the compare list). */
	versions: ReadonlyArray<DemoVersionOption>
	/** The primary version, excluded from the compare options. */
	primaryVersion: string | null
	/** Whether compare mode is on. */
	compareMode: boolean
	/** Fired when the visitor flips compare mode. */
	onCompareModeChange: (compareMode: boolean) => void
	/** The version chosen to compare against, or `null` when none is chosen. */
	compareVersion: string | null
	/** Fired with the chosen compare version (or `null` when the empty option is picked). */
	onCompareVersionChange: (version: string | null) => void
	/** Disable the compare-version select (e.g. while a parse or compare load runs). */
	disabled?: boolean
	/** A status line rendered under the select (e.g. the compare backend, or a "Loading…" line). */
	status?: ReactNode
}

/** The compare toggle + (when on) the compare-version selector. Renders `null` with fewer than two versions. */
export function CompareToggle({
	versions,
	primaryVersion,
	compareMode,
	onCompareModeChange,
	compareVersion,
	onCompareVersionChange,
	disabled,
	status,
}: CompareToggleProps): ReactNode {
	if (versions.length < 2) return null

	const options = versions.filter((v) => v.version !== primaryVersion)

	return (
		<div className="mw-demo-compare">
			<label className="mw-demo-compare__toggle">
				<input type="checkbox" checked={compareMode} onChange={(e) => onCompareModeChange(e.target.checked)} /> Compare
			</label>
			{compareMode ? (
				<div className="mw-demo-control">
					<label className="mw-demo-control__label" htmlFor="mw-demo-compare-version">
						Compare with
					</label>
					<select
						id="mw-demo-compare-version"
						className="mw-demo-control__select"
						value={compareVersion ?? ""}
						onChange={(e) => onCompareVersionChange(e.target.value || null)}
						disabled={disabled}
					>
						<option value="">Select version…</option>
						{options.map((v) => (
							<option key={v.version} value={v.version}>
								{v.label ?? v.version}
							</option>
						))}
					</select>
					{status ? <p className="mw-demo-compare__status">{status}</p> : null}
				</div>
			) : null}
		</div>
	)
}
