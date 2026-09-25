/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders a compare-mode checkbox and a selector for the second model version. The host runs the
 *   comparison.
 */

import type { ReactNode } from "react"

import type { VersionOption } from "#map/types"

/**
 * Props for {@link CompareToggle}.
 */
export interface CompareToggleProps {
	/**
	 * The selectable model versions.
	 */
	versions: ReadonlyArray<VersionOption>
	/**
	 * The primary version, which the compare list leaves out.
	 */
	primaryVersion: string | null
	/**
	 * Whether compare mode is on.
	 */
	compareMode: boolean
	/**
	 * Called when the visitor toggles compare mode.
	 */
	onCompareModeChange: (compareMode: boolean) => void
	/**
	 * The version to compare against, or `null` when none is chosen.
	 */
	compareVersion: string | null
	/**
	 * Called with the chosen version, or with `null` when the visitor picks the empty option.
	 */
	onCompareVersionChange: (version: string | null) => void
	/**
	 * Disables the version select, for example while a parse runs.
	 */
	disabled?: boolean
	/**
	 * A status line shown under the select, such as the compare backend or a loading message.
	 */
	status?: ReactNode
}

/**
 * Renders the compare checkbox and, in compare mode, the version selector.
 * It renders nothing when fewer than two versions exist.
 */
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
			<label className="mw-map-sheet__check mw-demo-compare__toggle">
				<input type="checkbox" checked={compareMode} onChange={(event) => onCompareModeChange(event.target.checked)} />
				Compare two model versions
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
