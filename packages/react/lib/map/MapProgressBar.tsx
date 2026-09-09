/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<MapProgressBar>` — the loading bar pinned across the top of the viewport.
 *
 *   Loading a 38 MB model is a page-level event, not a control-level one, so it reports at the page's edge rather than
 *   inside the search field: a spinner in the field resizes the one control a visitor is trying to type into, and a
 *   staged list in the result sheet claims the space an answer will need.
 *
 *   It reports a FRACTION when the loader names its steps and runs indeterminate when it does not, because a bar that
 *   invents a percentage is worse than one that admits it is only saying "still working".
 *
 *   NODE-SAFE: pure React, no maplibre.
 */

import type { ReactNode } from "react"

import { cx } from "#common/cx"

export interface MapProgressBarProps {
	/**
	 * Whether the bar is showing at all. It stays mounted through its fade rather than unmounting on the transition.
	 */
	active: boolean
	/**
	 * Completed steps over total steps, in [0, 1]. Omit for work whose length is unknown.
	 */
	fraction?: number | null
	/**
	 * The bar's accessible name — what is loading, in a few words.
	 */
	label: string
	className?: string
}

export function MapProgressBar({ active, fraction, label, className }: MapProgressBarProps): ReactNode {
	const determinate = typeof fraction === "number" && Number.isFinite(fraction)
	const clamped = determinate ? Math.min(1, Math.max(0, fraction)) : 0

	return (
		<div
			className={cx("mw-map-progress", !active && "mw-map-progress--idle", className)}
			role="progressbar"
			aria-label={label}
			aria-hidden={!active}
			aria-valuemin={determinate ? 0 : undefined}
			aria-valuemax={determinate ? 100 : undefined}
			aria-valuenow={determinate ? Math.round(clamped * 100) : undefined}
		>
			<div
				className={cx("mw-map-progress__fill", !determinate && "mw-map-progress__fill--indeterminate")}
				style={determinate ? { transform: `scaleX(${clamped})` } : undefined}
			/>
		</div>
	)
}
