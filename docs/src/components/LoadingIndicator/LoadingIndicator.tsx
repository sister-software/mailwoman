/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * LoadingIndicator — pure-CSS loading states for three UX patterns:
 *
 *   pulse   — animated opacity skeleton bars (content-placeholder shimmer)
 *   spinner — CSS border-top rotation ring (in-progress spinner)
 *   staged  — step list with animated checkmarks (pipeline / multi-phase progress)
 *
 * SSR-safe: all animations are CSS-driven; no DOM measurement or browser APIs at
 * render time. The component renders identically on server and client.
 */

import classNames from "classnames"
import { memo } from "react"

import styles from "./styles.module.css"

// ── Types ────────────────────────────────────────────────────────────────

export type LoadingMode = "pulse" | "spinner" | "staged"

export interface LoadingIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
	/**
	 * Visual mode.
	 * @default "spinner"
	 */
	mode?: LoadingMode

	/**
	 * Optional label rendered below the indicator.
	 * In staged mode this is shown above the step list.
	 */
	label?: string

	// -- pulse mode --

	/** Number of skeleton bars. Ignored when mode !== "pulse". @default 3 */
	barCount?: number

	// -- spinner mode --

	/** Spinner ring size. @default "medium" */
	size?: "small" | "medium" | "large"

	// -- staged mode --

	/** Step labels. Each entry is one row. */
	steps?: string[]

	/**
	 * Index of the currently active step (0-based).
	 * Steps before this index are marked complete (checkmark).
	 * Steps after this index are pending (dimmed).
	 * @default -1 (all pending)
	 */
	activeStep?: number
}

// ── Internal helpers ─────────────────────────────────────────────────────

const SIZE_CLASS: Record<NonNullable<LoadingIndicatorProps["size"]>, string> = {
	small: styles.spinnerSmall,
	medium: "",
	large: styles.spinnerLarge,
}

// ── Component ────────────────────────────────────────────────────────────

export const LoadingIndicator = memo<LoadingIndicatorProps>(
	({ mode = "spinner", label, barCount = 3, size = "medium", steps, activeStep = -1, className, ...rest }) => {
		return (
			<div className={classNames(styles.container, className)} role="status" aria-label={label ?? "Loading"} {...rest}>
				{mode === "pulse" && <PulseBars count={barCount} />}
				{mode === "spinner" && <SpinnerRing size={size} />}
				{mode === "staged" && <StagedProgress steps={steps} activeStep={activeStep} />}
				{label ? <span className={styles.label}>{label}</span> : null}
			</div>
		)
	}
)

LoadingIndicator.displayName = "LoadingIndicator"

// ── Sub-renderers ────────────────────────────────────────────────────────

interface PulseBarsProps {
	count: number
}

const PulseBars = memo<PulseBarsProps>(({ count }) => (
	<div className={styles.pulseTrack}>
		{Array.from({ length: count }, (_, i) => (
			<div key={i} className={styles.pulseBar} />
		))}
	</div>
))

PulseBars.displayName = "PulseBars"

interface SpinnerRingProps {
	size: NonNullable<LoadingIndicatorProps["size"]>
}

const SpinnerRing = memo<SpinnerRingProps>(({ size }) => (
	<div className={classNames(styles.spinner, SIZE_CLASS[size])} />
))

SpinnerRing.displayName = "SpinnerRing"

interface StagedProgressProps {
	steps?: string[]
	activeStep: number
}

const StagedProgress = memo<StagedProgressProps>(({ steps, activeStep }) => {
	if (!steps || steps.length === 0) return null

	return (
		<ul className={styles.stagedList}>
			{steps.map((step, i) => {
				const isComplete = i < activeStep
				const isActive = i === activeStep

				const rowClass = classNames(styles.stagedStep, {
					[styles.stagedComplete]: isComplete,
					[styles.stagedActive]: isActive,
					[styles.stagedPending]: !isComplete && !isActive,
				})

				return (
					<li key={i} className={rowClass}>
						<span className={styles.stepIcon}>
							{isComplete ? <span className={styles.checkmark} /> : isActive ? <span className={styles.activeDot} /> : null}
						</span>
						<span>{step}</span>
					</li>
				)
			})}
		</ul>
	)
})

StagedProgress.displayName = "StagedProgress"
