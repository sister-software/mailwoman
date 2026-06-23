/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CalibrationShowcase — the "our confidence means something" panel.
 *
 *   A geocoder that returns a result and a search index that returns a result look the same until one
 *   of them is wrong. The difference a calibrated parser offers is that its confidence is a
 *   probability you can route on: a span marked 90% is right ~90% of the time. This component
 *   proves that property visually, live, from the deployed model's own held-out reliability.
 *
 *   It fetches the version's `calibration.json` (the same isotonic table the decoder calibrator
 *   reads) and hand-draws two SVGs — no chart library:
 *
 *   1. Reliability diagram — mean confidence (x) vs measured accuracy (y), per bin, before and after
 *        calibration. Perfect calibration sits on the diagonal; the raw points drift off it, the
 *        calibrated points snap back. Dot area ∝ bin population, so the eye weights the bins that
 *        hold the mass instead of the single-sample noise in the tail.
 *   2. Abstention curve — as you raise the auto-accept threshold, coverage falls and precision climbs.
 *        This is the deployable artifact: "auto-accept above T, send the rest to review."
 *
 *   Data contract: `reliability_raw` / `reliability_cal` (arrays of `{n, conf, acc}`),
 *   `abstention_curve` (`{threshold, coverage, precision}`), and `metrics.ece_{raw,cal}_eval`, all
 *   emitted by `scripts/eval/fit-isotonic-calibration.py`.
 */

import React, { useEffect, useState } from "react"

import { DEFAULT_LOCALE } from "../../shared/demo-helpers.ts"
import { assetUrl } from "../../shared/resources.tsx"

interface ReliabilityBin {
	n: number
	conf: number | null
	acc: number | null
}

interface AbstentionPoint {
	threshold: number
	coverage: number
	precision: number
}

interface CalibrationData {
	model_version: string
	metrics: { ece_raw_eval: number; ece_cal_eval: number }
	reliability_raw: ReliabilityBin[]
	reliability_cal: ReliabilityBin[]
	abstention_curve: AbstentionPoint[]
}

export interface CalibrationShowcaseProps {
	/** Model version to load the table for. Defaults to the demo's default release. */
	version?: string
	/** Locale dir on R2. */
	locale?: string
}

// Palette via theme vars where possible; fixed hexes for the two data series so the legend reads.
const RAW_COLOR = "#e8833a" // amber — the un-calibrated softmax score
const CAL_COLOR = "#2e8b8b" // teal — after isotonic calibration

export default function CalibrationShowcase({
	version = "v4.13.0",
	locale = DEFAULT_LOCALE,
}: CalibrationShowcaseProps): React.ReactElement {
	const [data, setData] = useState<CalibrationData | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		void (async () => {
			try {
				const res = await fetch(assetUrl(locale, version, "calibration.json"))
				if (!res.ok) throw new Error(`calibration.json ${res.status}`)
				const json = (await res.json()) as CalibrationData
				if (!cancelled) setData(json)
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [version, locale])

	if (error) {
		return <div style={{ color: "var(--ifm-color-danger)", fontSize: 14 }}>Couldn’t load calibration data: {error}</div>
	}
	if (!data) {
		return <div style={{ color: "var(--ifm-color-emphasis-600)", fontSize: 14 }}>Loading calibration data…</div>
	}

	const eceRaw = data.metrics.ece_raw_eval
	const eceCal = data.metrics.ece_cal_eval
	const improvement = eceRaw / eceCal

	return (
		<div style={{ margin: "1.5rem 0" }}>
			<div
				style={{
					display: "flex",
					flexWrap: "wrap",
					gap: 12,
					alignItems: "baseline",
					marginBottom: 12,
					fontSize: 14,
				}}
			>
				<strong>Calibration error (ECE), held-out:</strong>
				<span>
					raw <code style={{ color: RAW_COLOR }}>{eceRaw.toFixed(3)}</code> → calibrated{" "}
					<code style={{ color: CAL_COLOR }}>{eceCal.toFixed(3)}</code>
				</span>
				<span style={{ color: "var(--ifm-color-emphasis-600)" }}>
					({improvement.toFixed(1)}× tighter · model {data.model_version})
				</span>
			</div>

			<div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
				<ReliabilityDiagram raw={data.reliability_raw} cal={data.reliability_cal} />
				<AbstentionCurve points={data.abstention_curve} />
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Reliability diagram
// ---------------------------------------------------------------------------

function ReliabilityDiagram({ raw, cal }: { raw: ReliabilityBin[]; cal: ReliabilityBin[] }): React.ReactElement {
	const W = 340
	const H = 300
	const pad = { l: 44, r: 12, t: 12, b: 40 }
	const plotW = W - pad.l - pad.r
	const plotH = H - pad.t - pad.b
	// Zoom to [0.4, 1] — that's where the populated bins live; full [0,1] wastes 40% of the canvas.
	const lo = 0.4
	const x = (v: number) => pad.l + ((v - lo) / (1 - lo)) * plotW
	const y = (v: number) => pad.t + (1 - (v - lo) / (1 - lo)) * plotH

	// Restrict to the zoomed window on BOTH axes — the handful of sub-0.4 bins are the n≤2 noise tail
	// (the full per-bin table in the eval report keeps them); plotting them would push dots off-canvas.
	const bins = (arr: ReliabilityBin[]) =>
		arr.filter(
			(b): b is ReliabilityBin & { conf: number; acc: number } =>
				b.n > 0 && b.conf != null && b.acc != null && b.conf >= lo && b.acc >= lo
		)
	const maxN = Math.max(1, ...raw.concat(cal).map((b) => b.n))
	const r = (n: number) => 2 + 9 * Math.sqrt(n / maxN)

	const ticks = [0.4, 0.6, 0.8, 1.0]

	return (
		<figure style={{ margin: 0 }}>
			<svg width={W} height={H} role="img" aria-label="Reliability diagram: confidence vs accuracy, raw vs calibrated">
				{/* axes */}
				<line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + plotH} stroke="var(--ifm-color-emphasis-300)" />
				<line
					x1={pad.l}
					y1={pad.t + plotH}
					x2={pad.l + plotW}
					y2={pad.t + plotH}
					stroke="var(--ifm-color-emphasis-300)"
				/>
				{/* perfect-calibration diagonal */}
				<line x1={x(lo)} y1={y(lo)} x2={x(1)} y2={y(1)} stroke="var(--ifm-color-emphasis-500)" strokeDasharray="4 3" />
				<text
					x={x(0.82)}
					y={y(0.82) - 6}
					fontSize={10}
					fill="var(--ifm-color-emphasis-600)"
					transform={`rotate(-33 ${x(0.82)} ${y(0.82)})`}
				>
					perfectly calibrated
				</text>
				{/* ticks */}
				{ticks.map((t) => (
					<g key={`xt-${t}`}>
						<text
							x={x(t)}
							y={pad.t + plotH + 16}
							fontSize={10}
							textAnchor="middle"
							fill="var(--ifm-color-emphasis-600)"
						>
							{t.toFixed(1)}
						</text>
						<text x={pad.l - 8} y={y(t) + 3} fontSize={10} textAnchor="end" fill="var(--ifm-color-emphasis-600)">
							{t.toFixed(1)}
						</text>
					</g>
				))}
				{/* raw points */}
				{bins(raw).map((b, i) => (
					<circle key={`raw-${i}`} cx={x(b.conf)} cy={y(b.acc)} r={r(b.n)} fill={RAW_COLOR} fillOpacity={0.55} />
				))}
				{/* calibrated points */}
				{bins(cal).map((b, i) => (
					<circle key={`cal-${i}`} cx={x(b.conf)} cy={y(b.acc)} r={r(b.n)} fill={CAL_COLOR} fillOpacity={0.7} />
				))}
				{/* axis labels */}
				<text x={pad.l + plotW / 2} y={H - 4} fontSize={11} textAnchor="middle" fill="var(--ifm-color-emphasis-700)">
					stated confidence
				</text>
				<text
					x={12}
					y={pad.t + plotH / 2}
					fontSize={11}
					textAnchor="middle"
					fill="var(--ifm-color-emphasis-700)"
					transform={`rotate(-90 12 ${pad.t + plotH / 2})`}
				>
					measured accuracy
				</text>
			</svg>
			<figcaption style={{ fontSize: 12, color: "var(--ifm-color-emphasis-700)", maxWidth: W }}>
				<Dot color={RAW_COLOR} /> raw softmax sits <em>below</em> the line (over-stated) or above (under-stated);{" "}
				<Dot color={CAL_COLOR} /> calibrated snaps onto it. Dot area ∝ how many spans land in that bin.
			</figcaption>
		</figure>
	)
}

// ---------------------------------------------------------------------------
// Abstention curve
// ---------------------------------------------------------------------------

function AbstentionCurve({ points }: { points: AbstentionPoint[] }): React.ReactElement {
	const W = 340
	const H = 300
	const pad = { l: 44, r: 12, t: 12, b: 40 }
	const plotW = W - pad.l - pad.r
	const plotH = H - pad.t - pad.b
	const tLo = Math.min(...points.map((p) => p.threshold))
	const tHi = Math.max(...points.map((p) => p.threshold))
	const x = (t: number) => pad.l + ((t - tLo) / (tHi - tLo)) * plotW
	const y = (frac: number) => pad.t + (1 - frac) * plotH

	const line = (sel: (p: AbstentionPoint) => number) => points.map((p) => `${x(p.threshold)},${y(sel(p))}`).join(" ")

	const yTicks = [0, 0.25, 0.5, 0.75, 1.0]

	return (
		<figure style={{ margin: 0 }}>
			<svg width={W} height={H} role="img" aria-label="Abstention curve: coverage and precision vs accept threshold">
				<line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + plotH} stroke="var(--ifm-color-emphasis-300)" />
				<line
					x1={pad.l}
					y1={pad.t + plotH}
					x2={pad.l + plotW}
					y2={pad.t + plotH}
					stroke="var(--ifm-color-emphasis-300)"
				/>
				{yTicks.map((t) => (
					<g key={`yt-${t}`}>
						<line x1={pad.l} y1={y(t)} x2={pad.l + plotW} y2={y(t)} stroke="var(--ifm-color-emphasis-200)" />
						<text x={pad.l - 8} y={y(t) + 3} fontSize={10} textAnchor="end" fill="var(--ifm-color-emphasis-600)">
							{Math.round(t * 100)}
						</text>
					</g>
				))}
				{points.map((p) => (
					<text
						key={`xt-${p.threshold}`}
						x={x(p.threshold)}
						y={pad.t + plotH + 16}
						fontSize={10}
						textAnchor="middle"
						fill="var(--ifm-color-emphasis-600)"
					>
						{p.threshold}
					</text>
				))}
				{/* precision: high, rising */}
				<polyline points={line((p) => p.precision)} fill="none" stroke={CAL_COLOR} strokeWidth={2} />
				{points.map((p) => (
					<circle key={`pr-${p.threshold}`} cx={x(p.threshold)} cy={y(p.precision)} r={3} fill={CAL_COLOR} />
				))}
				{/* coverage: falling */}
				<polyline points={line((p) => p.coverage)} fill="none" stroke={RAW_COLOR} strokeWidth={2} />
				{points.map((p) => (
					<circle key={`cv-${p.threshold}`} cx={x(p.threshold)} cy={y(p.coverage)} r={3} fill={RAW_COLOR} />
				))}
				<text x={pad.l + plotW / 2} y={H - 4} fontSize={11} textAnchor="middle" fill="var(--ifm-color-emphasis-700)">
					auto-accept threshold
				</text>
				<text
					x={12}
					y={pad.t + plotH / 2}
					fontSize={11}
					textAnchor="middle"
					fill="var(--ifm-color-emphasis-700)"
					transform={`rotate(-90 12 ${pad.t + plotH / 2})`}
				>
					percent
				</text>
			</svg>
			<figcaption style={{ fontSize: 12, color: "var(--ifm-color-emphasis-700)", maxWidth: W }}>
				<Dot color={CAL_COLOR} /> precision of the accepted set climbs as you raise the bar; <Dot color={RAW_COLOR} />{" "}
				coverage is how much you auto-accept. The gap is what you route to a human.
			</figcaption>
		</figure>
	)
}

function Dot({ color }: { color: string }): React.ReactElement {
	return (
		<span
			style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: color, marginRight: 2 }}
		/>
	)
}
