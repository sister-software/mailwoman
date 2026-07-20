/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   LoadingIndicator — pure-CSS loading states for three UX patterns: `pulse` (skeleton bars),
 *   `spinner` (rotation ring), and `staged` (a step list with checkmarks). SSR-safe: every animation
 *   is CSS-driven, so the component renders identically on server and client. Ported from the docs
 *   component onto plain (`mw-`-prefixed) class names.
 */

import { memo, type ReactNode } from "react"

import { cx } from "./cx.ts"

export type LoadingMode = "pulse" | "spinner" | "staged"

export interface LoadingIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
	/** @default "spinner" */
	mode?: LoadingMode
	/** Optional label; in staged mode it renders above the step list. */
	label?: string
	/** Number of skeleton bars (pulse mode). @default 3 */
	barCount?: number
	/** Spinner ring size. @default "medium" */
	size?: "small" | "medium" | "large"
	/** Step labels (staged mode) — one row each. */
	steps?: string[]
	/** 0-based index of the active step; earlier steps are complete, later ones pending. @default -1 */
	activeStep?: number
}

const SIZE_CLASS: Record<NonNullable<LoadingIndicatorProps["size"]>, string> = {
	small: "mw-spinner--small",
	medium: "",
	large: "mw-spinner--large",
}

export const LoadingIndicator = memo<LoadingIndicatorProps>(function LoadingIndicator({
	mode = "spinner",
	label,
	barCount = 3,
	size = "medium",
	steps,
	activeStep = -1,
	className,
	...rest
}) {
	return (
		<div className={cx("mw-loading", className)} role="status" aria-label={label ?? "Loading"} {...rest}>
			{mode === "pulse" ? <PulseBars count={barCount} /> : null}
			{mode === "spinner" ? <SpinnerRing size={size} /> : null}
			{mode === "staged" ? <StagedProgress steps={steps} activeStep={activeStep} /> : null}
			{label ? <span className="mw-loading__label">{label}</span> : null}
		</div>
	)
})

const PulseBars = memo<{ count: number }>(function PulseBars({ count }) {
	return (
		<div className="mw-pulse">
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="mw-pulse__bar" />
			))}
		</div>
	)
})

const SpinnerRing = memo<{ size: NonNullable<LoadingIndicatorProps["size"]> }>(function SpinnerRing({ size }) {
	return <div className={cx("mw-spinner", SIZE_CLASS[size])} />
})

const StagedProgress = memo<{ steps?: string[]; activeStep: number }>(function StagedProgress({ steps, activeStep }) {
	if (!steps || steps.length === 0) return null

	return (
		<ul className="mw-staged">
			{steps.map((step, i): ReactNode => {
				const isComplete = i < activeStep
				const isActive = i === activeStep

				return (
					<li
						key={i}
						className={cx("mw-staged__step", {
							"mw-staged__step--complete": isComplete,
							"mw-staged__step--active": isActive,
							"mw-staged__step--pending": !isComplete && !isActive,
						})}
					>
						<span className="mw-staged__icon">
							{isComplete ? (
								<span className="mw-staged__check" />
							) : isActive ? (
								<span className="mw-staged__dot" />
							) : null}
						</span>
						<span>{step}</span>
					</li>
				)
			})}
		</ul>
	)
})
