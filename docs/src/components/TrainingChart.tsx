/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * TrainingChart — wraps a training-run SVG chart with a linear/log scale toggle.
 *
 * Place a linear-scale SVG at `path/to/chart.svg` and its log-scale variant at
 * `path/to/chart-log.svg` (generated via `scripts/log-scale-chart.ts` or
 * `scripts/training-chart.ts --log`). The component automatically derives the
 * log URL and renders a toggle button.
 *
 * Usage in MDX:
 *
 * ```mdx
 * import TrainingChart from "@site/src/components/TrainingChart"
 *
 * <TrainingChart src={require("../evals/charts/v06x-val-loss.svg").default} />
 * ```
 *
 * Or with a pre-resolved logSrc:
 *
 * ```mdx
 * <TrainingChart
 *   src={require("../evals/charts/v06x-val-loss.svg").default}
 *   logSrc={require("../evals/charts/v06x-val-loss-log.svg").default}
 * />
 * ```
 */

import React, { useState } from "react"

export interface TrainingChartProps {
	/** Path to the linear-scale SVG. */
	src: string
	/** Optional explicit path to the log-scale SVG. Auto-derived if omitted. */
	logSrc?: string
	/** Alt text for the chart image. */
	alt?: string
}

export default function TrainingChart({ src, logSrc, alt }: TrainingChartProps): React.ReactElement {
	const derivedLogSrc = logSrc ?? src.replace(/\.svg$/, "-log.svg")
	const [scale, setScale] = useState<"linear" | "log">("linear")

	const currentSrc = scale === "linear" ? src : derivedLogSrc

	return (
		<div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
			<div
				style={{
					display: "flex",
					gap: "6px",
					marginBottom: "8px",
				}}
			>
				<button
					type="button"
					onClick={() => setScale("linear")}
					style={{
						padding: "4px 10px",
						fontSize: "12px",
						fontFamily: "inherit",
						border: "1px solid var(--ifm-color-emphasis-300)",
						borderRadius: "4px",
						background: scale === "linear" ? "var(--ifm-color-primary)" : "var(--ifm-color-emphasis-0)",
						color: scale === "linear" ? "white" : "var(--ifm-color-emphasis-700)",
						cursor: "pointer",
					}}
				>
					Linear
				</button>
				<button
					type="button"
					onClick={() => setScale("log")}
					style={{
						padding: "4px 10px",
						fontSize: "12px",
						fontFamily: "inherit",
						border: "1px solid var(--ifm-color-emphasis-300)",
						borderRadius: "4px",
						background: scale === "log" ? "var(--ifm-color-primary)" : "var(--ifm-color-emphasis-0)",
						color: scale === "log" ? "white" : "var(--ifm-color-emphasis-700)",
						cursor: "pointer",
					}}
				>
					Log
				</button>
			</div>
			<img
				src={currentSrc}
				alt={alt ?? "Training chart"}
				style={{ maxWidth: "100%", display: "block" }}
			/>
		</div>
	)
}
