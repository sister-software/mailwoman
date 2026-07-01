/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   TrainingCharts — interactive training metrics dashboard pulling from the Trackio API. Shows
 *   train_loss, val_loss, val_macro_f1, and per-component F1 scores as pure SVG line charts with
 *   hover tooltips.
 *
 *   Usage in MDX:
 *
 *   ```mdx
 *   import { TrainingCharts } from "@site/src/components/TrainingCharts/TrainingCharts"
 *
 *   <TrainingCharts />
 * ```
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { LoadingIndicator } from "../LoadingIndicator/LoadingIndicator.tsx"

import styles from "./styles.module.css"

// ── Constants ───────────────────────────────────────────────────────────

const TRACKIO_BASE = "https://sister-software-mailwoman-trackio.hf.space"
const PROJECT = "mailwoman"
const POLL_INTERVAL_MS = 30_000

/** Default metrics to enable on first load. */
const DEFAULT_METRICS = ["train_loss", "val_loss", "val_macro_f1"]

/** All known metric keys — populated dynamically but these are the common ones. */
const KNOWN_METRICS: Array<{ key: string; label: string; group: "loss" | "f1" | "support" }> = [
	{ key: "train_loss", label: "train loss", group: "loss" },
	{ key: "val_loss", label: "val loss", group: "loss" },
	{ key: "val_macro_f1", label: "macro F1", group: "f1" },
	{ key: "f1.country", label: "F1 country", group: "f1" },
	{ key: "f1.region", label: "F1 region", group: "f1" },
	{ key: "f1.locality", label: "F1 locality", group: "f1" },
	{ key: "f1.dependent_locality", label: "F1 dep. locality", group: "f1" },
	{ key: "f1.postcode", label: "F1 postcode", group: "f1" },
	{ key: "f1.street", label: "F1 street", group: "f1" },
	{ key: "f1.house_number", label: "F1 house number", group: "f1" },
	{ key: "f1.venue", label: "F1 venue", group: "f1" },
]

const LINE_COLORS = [
	"#3578e5",
	"#8b5cf6",
	"#14b8a6",
	"#f59e0b",
	"#ef4444",
	"#ec4899",
	"#6366f1",
	"#10b981",
	"#f97316",
	"#06b6d4",
	"#84cc16",
	"#a855f7",
]

// ── Types ────────────────────────────────────────────────────────────────

interface MetricPoint {
	step: number
	value: number
	timestamp: number
}

interface RunInfo {
	name: string
	created_at?: string
	state?: string
}

interface RunSummary {
	metrics?: string[]
	[key: string]: unknown
}

/** One rendered line on the chart. */
interface ChartSeries {
	run: string
	metric: string
	label: string
	color: string
	points: MetricPoint[]
}

/** Hover tooltip state — x/y are CSS-pixel offsets relative to the chart wrapper. */
interface TooltipDatum {
	series: ChartSeries
	point: MetricPoint
	x: number
	y: number
}

// ── API helpers ──────────────────────────────────────────────────────────

async function apiPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
	const res = await fetch(`${TRACKIO_BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		throw new Error(`Trackio ${path} returned ${res.status}: ${await res.text().catch(() => "unknown")}`)
	}

	return res.json() as Promise<T>
}

async function fetchRuns(): Promise<RunInfo[]> {
	const data = await apiPost<{ data?: RunInfo[] }>("/api/get_runs_for_project", { project: PROJECT })

	return data.data ?? []
}

async function fetchRunSummary(run: string): Promise<RunSummary> {
	const data = await apiPost<{ data?: RunSummary }>("/api/get_run_summary", { project: PROJECT, run })

	return data.data ?? ({} as RunSummary)
}

async function fetchMetricValues(run: string, metric: string): Promise<MetricPoint[]> {
	const data = await apiPost<{ data?: MetricPoint[] }>("/api/get_metric_values", {
		project: PROJECT,
		run,
		metric_name: metric,
	})

	return data.data ?? []
}

// ── Helpers ──────────────────────────────────────────────────────────────

function niceTicks(min: number, max: number, count: number): number[] {
	if (min === max) return [min]
	const range = max - min
	const roughStep = range / (count - 1)
	const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
	const residual = roughStep / magnitude
	let niceStep: number

	if (residual <= 1.5) niceStep = 1 * magnitude
	else if (residual <= 3) niceStep = 2 * magnitude
	else if (residual <= 7) niceStep = 5 * magnitude
	else niceStep = 10 * magnitude

	const niceMin = Math.floor(min / niceStep) * niceStep
	const niceMax = Math.ceil(max / niceStep) * niceStep
	const ticks: number[] = []

	for (let v = niceMin; v <= niceMax + niceStep * 0.5; v += niceStep) {
		ticks.push(Math.round(v * 1e10) / 1e10)
	}

	return ticks
}

function formatValue(v: number): string {
	if (v === 0) return "0"

	if (Math.abs(v) < 0.001) return v.toExponential(2)

	if (Math.abs(v) < 1) return v.toFixed(4)

	if (Math.abs(v) < 100) return v.toFixed(3)

	if (Math.abs(v) < 10_000) return v.toFixed(1)

	return v.toExponential(2)
}

// ── SVG Chart sub-component ──────────────────────────────────────────────

const SVG_PAD = { top: 30, right: 20, bottom: 40, left: 60 }
const SVG_WIDTH = 720
const SVG_HEIGHT = 380

type ScaleMode = "linear" | "log"

interface SVGChartProps {
	series: ChartSeries[]
	containerRef: React.RefObject<HTMLDivElement | null>
	onHover: (d: TooltipDatum | null) => void
	scaleMode: ScaleMode
}

const SVGChart: React.FC<SVGChartProps> = ({ series, containerRef, onHover, scaleMode }) => {
	const allPoints = useMemo(() => series.flatMap((s) => s.points), [series])

	const isLog = scaleMode === "log"

	// In log mode, we map y through log10 and work in log-space.
	const { xMin, xMax, yMin, yMax, yMinData } = useMemo(() => {
		if (allPoints.length === 0) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1, yMinData: 0 }
		let xmn = Infinity,
			xmx = -Infinity,
			ymn = Infinity,
			ymx = -Infinity

		for (const p of allPoints) {
			if (p.step < xmn) xmn = p.step

			if (p.step > xmx) xmx = p.step

			if (p.value < ymn) ymn = p.value

			if (p.value > ymx) ymx = p.value
		}
		const yPad = (ymx - ymn) * 0.05 || 0.01
		const yMinData = ymn - yPad
		const yMaxData = ymx + yPad

		if (!isLog) return { xMin: xmn, xMax: xmx, yMin: yMinData, yMax: yMaxData, yMinData }
		// Log scale: the floor must come from the smallest *positive* data value, not the
		// linearly-padded minimum — otherwise a metric that touches/approaches zero (F1 scores
		// start near 0, val_loss can be tiny) drags the floor to ~0 and the axis spans many
		// empty decades, squashing the real data into a sliver. Pad in log-space, not linear.
		let posMin = Infinity

		for (const p of allPoints) {
			if (p.value > 0 && p.value < posMin) posMin = p.value
		}

		if (!Number.isFinite(posMin)) posMin = 1e-6 // all values non-positive; nominal floor
		const posMax = Math.max(ymx, posMin * 10)
		const logMin = Math.log10(posMin)
		const logMax = Math.log10(posMax)
		const logPad = (logMax - logMin) * 0.05 || 0.05

		return {
			xMin: xmn,
			xMax: xmx,
			yMin: logMin - logPad,
			yMax: logMax + logPad,
			yMinData: posMin,
		}
	}, [allPoints, isLog])

	const plotW = SVG_WIDTH - SVG_PAD.left - SVG_PAD.right
	const plotH = SVG_HEIGHT - SVG_PAD.top - SVG_PAD.bottom

	const xScale = useCallback(
		(x: number) => SVG_PAD.left + ((x - xMin) / (xMax - xMin || 1)) * plotW,
		[xMin, xMax, plotW]
	)
	const yScale = useCallback(
		(y: number) => {
			// Clamp ≤0 values to the positive floor so they rest on the axis bottom (log10(0) = -∞).
			const vy = isLog ? Math.log10(Math.max(y, yMinData)) : y

			return SVG_PAD.top + plotH - ((vy - yMin) / (yMax - yMin || 1)) * plotH
		},
		[yMin, yMax, plotH, isLog, yMinData]
	)

	const yTicks = useMemo(() => {
		if (!isLog) return niceTicks(yMin, yMax, 6)
		// Log-scale ticks: powers of 10 and multiples
		const ticks: number[] = []
		const lo = Math.floor(yMin)
		const hi = Math.ceil(yMax)

		for (let exp = lo; exp <= hi; exp++) {
			ticks.push(Math.pow(10, exp))

			for (const m of [2, 3, 5, 7]) {
				const v = m * Math.pow(10, exp)

				if (Math.log10(v) >= yMin && Math.log10(v) <= yMax) ticks.push(v)
			}
		}

		return ticks.sort((a, b) => a - b)
	}, [yMin, yMax, isLog])
	const xTicks = useMemo(() => niceTicks(xMin, xMax, 8), [xMin, xMax])

	// Generate polyline points strings once per series
	const polyPoints = useMemo(() => {
		return series.map((s) => {
			if (s.points.length === 0) return ""

			return s.points.map((p) => `${xScale(p.step).toFixed(1)},${yScale(p.value).toFixed(1)}`).join(" ")
		})
	}, [series, xScale, yScale])

	const handleMouseMove = useCallback(
		(e: React.MouseEvent<SVGRectElement>) => {
			const svg = (e.target as SVGRectElement).closest("svg")!
			const svgRect = svg.getBoundingClientRect()
			const wrapperRect = containerRef.current?.getBoundingClientRect() ?? svgRect

			// ViewBox-relative coords for nearest-point search
			const mx = ((e.clientX - svgRect.left) / svgRect.width) * SVG_WIDTH
			const my = ((e.clientY - svgRect.top) / svgRect.height) * SVG_HEIGHT

			// Snap to nearest data point
			let best: TooltipDatum | null = null
			let bestDist = Infinity

			for (let si = 0; si < series.length; si++) {
				const s = series[si]

				for (const p of s.points) {
					const px = xScale(p.step)
					const py = yScale(p.value)
					const dist = Math.abs(mx - px) + Math.abs(my - py) * 2

					if (dist < bestDist && dist < 40) {
						bestDist = dist
						// Convert viewBox coords to wrapper-relative CSS pixels
						const sx = (px / SVG_WIDTH) * svgRect.width + (svgRect.left - wrapperRect.left)
						const sy = (py / SVG_HEIGHT) * svgRect.height + (svgRect.top - wrapperRect.top)
						best = { series: s, point: p, x: sx, y: sy }
					}
				}
			}

			onHover(best)
		},
		[series, xScale, yScale, onHover, containerRef]
	)

	if (allPoints.length === 0) {
		return (
			<svg viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} className={styles.chartSVG}>
				<text x={SVG_WIDTH / 2} y={SVG_HEIGHT / 2} textAnchor="middle" fill="#9ca3af" fontSize="14">
					No data points
				</text>
			</svg>
		)
	}

	return (
		<svg viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} className={styles.chartSVG}>
			{/* Background */}
			<rect width={SVG_WIDTH} height={SVG_HEIGHT} fill="var(--ifm-background-color, #fff)" />

			{/* Y-axis grid lines + labels */}
			{yTicks.map((v) => (
				<g key={`y-${v}`}>
					<line
						x1={SVG_PAD.left}
						x2={SVG_WIDTH - SVG_PAD.right}
						y1={yScale(v)}
						y2={yScale(v)}
						stroke="#e5e7eb"
						strokeWidth={1}
					/>
					<text x={SVG_PAD.left - 6} y={yScale(v) + 4} textAnchor="end" fontSize={11} fill="#6b7280">
						{formatValue(v)}
					</text>
				</g>
			))}

			{/* X-axis grid lines + labels */}
			{xTicks.map((v) => (
				<g key={`x-${v}`}>
					<line
						x1={xScale(v)}
						x2={xScale(v)}
						y1={SVG_PAD.top}
						y2={SVG_HEIGHT - SVG_PAD.bottom}
						stroke="#f3f4f6"
						strokeWidth={1}
					/>
					<text x={xScale(v)} y={SVG_HEIGHT - SVG_PAD.bottom + 18} textAnchor="middle" fontSize={11} fill="#6b7280">
						{v}
					</text>
				</g>
			))}

			{/* Y-axis label */}
			<text transform={`translate(14, ${SVG_HEIGHT / 2}) rotate(-90)`} textAnchor="middle" fontSize={12} fill="#374151">
				{isLog ? "value (log scale)" : "value"}
			</text>

			{/* X-axis label */}
			<text x={SVG_WIDTH / 2} y={SVG_HEIGHT - 4} textAnchor="middle" fontSize={12} fill="#374151">
				training step
			</text>

			{/* Data lines */}
			{series.map((s, si) => {
				if (s.points.length < 2) return null

				return (
					<g key={`${s.run}:${s.metric}`}>
						<polyline
							points={polyPoints[si]}
							fill="none"
							stroke={s.color}
							strokeWidth={1.8}
							strokeLinejoin="round"
							strokeLinecap="round"
						/>
						{/* Data point dots */}
						{s.points.map((p, pi) => (
							<circle
								key={pi}
								cx={xScale(p.step)}
								cy={yScale(p.value)}
								r={2.5}
								fill={s.color}
								stroke="#fff"
								strokeWidth={0.5}
							/>
						))}
					</g>
				)
			})}

			{/* Invisible hover target */}
			<rect
				x={SVG_PAD.left}
				y={SVG_PAD.top}
				width={plotW}
				height={plotH}
				fill="transparent"
				onMouseMove={handleMouseMove}
				onMouseLeave={() => onHover(null)}
			/>
		</svg>
	)
}

// ── Inner component (below BrowserOnly boundary) ─────────────────────────

const TrainingChartsInner: React.FC = () => {
	const [runs, setRuns] = useState<RunInfo[]>([])
	const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set())
	const [availableMetrics, setAvailableMetrics] = useState<Set<string>>(new Set())
	const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set(DEFAULT_METRICS))
	const [metricData, setMetricData] = useState<Map<string, Map<string, MetricPoint[]>>>(new Map())
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [pollCountdown, setPollCountdown] = useState(POLL_INTERVAL_MS / 1000)
	const [tooltip, setTooltip] = useState<TooltipDatum | null>(null)
	const [scaleMode, setScaleMode] = useState<ScaleMode>("linear")

	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
	const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
	const chartWrapperRef = useRef<HTMLDivElement | null>(null)

	// Fetch runs on mount
	useEffect(() => {
		let cancelled = false
		async function load() {
			try {
				const runList = await fetchRuns()

				if (cancelled) return
				setRuns(runList)
				setError(null)
				// Auto-select first N runs (max 4)
				const toSelect = runList.slice(0, 4).map((r) => r.name)
				setSelectedRuns(new Set(toSelect))
			} catch (err) {
				if (cancelled) return
				setError(err instanceof Error ? err.message : String(err))
			} finally {
				if (!cancelled) setLoading(false)
			}
		}
		load()

		return () => {
			cancelled = true
		}
	}, [])

	// When selected runs change, discover metrics and fetch data
	useEffect(() => {
		if (selectedRuns.size === 0) return

		let cancelled = false
		const newAvailable = new Set<string>()
		const newData = new Map<string, Map<string, MetricPoint[]>>()

		async function loadRunData(runName: string) {
			try {
				const summary = await fetchRunSummary(runName)

				if (cancelled) return
				const metrics = summary.metrics ?? []
				const runData = new Map<string, MetricPoint[]>()

				// Fetch data for each metric this run has
				const metricKeys = metrics

				for (const mk of metricKeys) {
					newAvailable.add(mk)

					try {
						const values = await fetchMetricValues(runName, mk)

						if (!cancelled) runData.set(mk, values)
					} catch {
						// Individual metric fetch failure is non-fatal
					}
				}

				if (!cancelled) newData.set(runName, runData)
			} catch {
				// Run summary fetch failure is non-fatal
			}
		}

		async function loadAll() {
			await Promise.all(Array.from(selectedRuns).map(loadRunData))

			if (cancelled) return
			setAvailableMetrics(newAvailable)
			setMetricData(newData)
		}

		loadAll()

		return () => {
			cancelled = true
		}
	}, [selectedRuns])

	// Auto-poll every POLL_INTERVAL_MS
	useEffect(() => {
		// Clear any existing intervals
		if (pollRef.current) clearInterval(pollRef.current)

		if (countdownRef.current) clearInterval(countdownRef.current)

		// eslint-disable-next-line react-hooks/set-state-in-effect
		setPollCountdown(POLL_INTERVAL_MS / 1000)

		// Countdown ticker (every 1s)
		countdownRef.current = setInterval(() => {
			setPollCountdown((prev) => {
				if (prev <= 1) return POLL_INTERVAL_MS / 1000

				return prev - 1
			})
		}, 1000)

		// Poll every POLL_INTERVAL_MS
		pollRef.current = setInterval(async () => {
			if (selectedRuns.size === 0) return

			const newData = new Map(metricData)

			for (const runName of selectedRuns) {
				const runMap = new Map(newData.get(runName) ?? [])

				for (const mk of selectedMetrics) {
					try {
						const values = await fetchMetricValues(runName, mk)
						runMap.set(mk, values)
					} catch {
						// ignore
					}
				}
				newData.set(runName, runMap)
			}
			setMetricData(newData)
		}, POLL_INTERVAL_MS)

		return () => {
			if (pollRef.current) clearInterval(pollRef.current)

			if (countdownRef.current) clearInterval(countdownRef.current)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedRuns, selectedMetrics])

	// Build chart series from metricData + selectedMetrics
	const chartSeries = useMemo(() => {
		const series: ChartSeries[] = []
		let colorIdx = 0

		for (const runName of selectedRuns) {
			const runData = metricData.get(runName)

			if (!runData) continue

			for (const mk of selectedMetrics) {
				const points = runData.get(mk)

				if (!points || points.length === 0) continue
				series.push({
					run: runName,
					metric: mk,
					label: `${runName} / ${mk}`,
					color: LINE_COLORS[colorIdx % LINE_COLORS.length],
					points: [...points].sort((a, b) => a.step - b.step),
				})
				colorIdx++
			}
		}

		return series
	}, [selectedRuns, selectedMetrics, metricData])

	// Handlers
	const handleRunToggle = useCallback((name: string) => {
		setSelectedRuns((prev) => {
			const next = new Set(prev)

			if (next.has(name)) next.delete(name)
			else next.add(name)

			return next
		})
	}, [])

	const handleMetricToggle = useCallback((key: string) => {
		setSelectedMetrics((prev) => {
			const next = new Set(prev)

			if (next.has(key)) next.delete(key)
			else next.add(key)

			return next
		})
	}, [])

	const handleTooltip = useCallback((d: TooltipDatum | null) => {
		setTooltip(d)
	}, [])

	// Visible metrics for checkbox display
	const visibleMetrics = useMemo(() => {
		const available = KNOWN_METRICS.filter((m) => availableMetrics.has(m.key))
		// Add any metrics from the API not in KNOWN_METRICS
		const knownKeys = new Set(KNOWN_METRICS.map((m) => m.key))

		for (const mk of availableMetrics) {
			if (!knownKeys.has(mk)) {
				available.push({ key: mk, label: mk, group: "f1" })
			}
		}

		return available
	}, [availableMetrics])

	// ── Render ──────────────────────────────────────────────────────────

	if (loading) {
		return (
			<div className={styles.container}>
				<LoadingIndicator mode="spinner" label="Fetching runs…" />
			</div>
		)
	}

	if (error) {
		return (
			<div className={styles.container}>
				<div className={styles.title}>Training metrics</div>
				<div className={styles.error}>Failed to load runs: {error}</div>
			</div>
		)
	}

	if (runs.length === 0) {
		return (
			<div className={styles.container}>
				<div className={styles.title}>Training metrics</div>
				<div className={styles.status}>No runs found for project &quot;{PROJECT}&quot;.</div>
			</div>
		)
	}

	return (
		<div className={styles.container}>
			<div className={styles.title}>Training metrics</div>

			{/* Poll indicator */}
			<div className={styles.pollBar}>
				<span className={`${styles.pollDot} ${styles.pollDotActive}`} />
				Auto-refresh in {pollCountdown}s
			</div>

			{/* Controls */}
			<div className={styles.controls}>
				{/* Run selector */}
				<div className={styles.controlGroup}>
					<span className={styles.controlLabel}>
						Runs ({selectedRuns.size}/{runs.length})
					</span>
					<div className={styles.metricCheckboxes}>
						{runs.map((r) => (
							<label
								key={r.name}
								className={`${styles.metricChip} ${selectedRuns.has(r.name) ? styles.metricChipChecked : ""}`}
							>
								<input type="checkbox" checked={selectedRuns.has(r.name)} onChange={() => handleRunToggle(r.name)} />
								{r.name}
							</label>
						))}
					</div>
				</div>

				{/* Metric selector */}
				{visibleMetrics.length > 0 ? (
					<div className={styles.controlGroup}>
						<span className={styles.controlLabel}>Metrics ({selectedMetrics.size})</span>
						<div className={styles.metricCheckboxes}>
							{visibleMetrics.map((m) => (
								<label
									key={m.key}
									className={`${styles.metricChip} ${selectedMetrics.has(m.key) ? styles.metricChipChecked : ""}`}
								>
									<input
										type="checkbox"
										checked={selectedMetrics.has(m.key)}
										onChange={() => handleMetricToggle(m.key)}
									/>
									{m.label}
								</label>
							))}
						</div>
					</div>
				) : null}
			</div>

			{/* Chart */}
			<div ref={chartWrapperRef} className={styles.chartWrapper}>
				{/* Scale toggle */}
				<div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
					<button
						type="button"
						onClick={() => setScaleMode("linear")}
						className={`${styles.metricChip} ${scaleMode === "linear" ? styles.metricChipChecked : ""}`}
					>
						Linear
					</button>
					<button
						type="button"
						onClick={() => setScaleMode("log")}
						className={`${styles.metricChip} ${scaleMode === "log" ? styles.metricChipChecked : ""}`}
					>
						Log
					</button>
				</div>
				<SVGChart series={chartSeries} containerRef={chartWrapperRef} onHover={handleTooltip} scaleMode={scaleMode} />

				{/* Tooltip overlay */}
				{tooltip ? (
					<div
						className={styles.tooltip}
						style={{
							left: `${Math.min(tooltip.x + 12, 520)}px`,
							top: `${Math.max(tooltip.y - 60, 10)}px`,
						}}
					>
						<div className={styles.tooltipRun} style={{ color: tooltip.series.color }}>
							{tooltip.series.label}
						</div>
						<div className={styles.tooltipRow}>
							<span className={styles.tooltipLabel}>step</span>
							<span className={styles.tooltipValue}>{tooltip.point.step}</span>
						</div>
						<div className={styles.tooltipRow}>
							<span className={styles.tooltipLabel}>value</span>
							<span className={styles.tooltipValue}>{formatValue(tooltip.point.value)}</span>
						</div>
					</div>
				) : null}
			</div>

			{/* Legend */}
			{chartSeries.length > 0 ? (
				<div className={styles.legend}>
					{chartSeries.map((s) => (
						<div key={`${s.run}:${s.metric}`} className={styles.legendItem}>
							<span className={styles.legendSwatch} style={{ background: s.color }} />
							{s.label}
						</div>
					))}
				</div>
			) : selectedRuns.size === 0 ? (
				<div className={styles.status}>Select at least one run to display metrics.</div>
			) : selectedMetrics.size === 0 ? (
				<div className={styles.status}>Select at least one metric to chart.</div>
			) : (
				<div className={styles.status}>No metric data available for the selected runs.</div>
			)}
		</div>
	)
}

// ── Public component (with BrowserOnly SSR boundary) ─────────────────────

export const TrainingCharts: React.FC = () => {
	return (
		<BrowserOnly
			fallback={
				<div className={styles.container}>
					<div className={styles.status}>Loading training charts…</div>
				</div>
			}
		>
			{() => <TrainingChartsInner />}
		</BrowserOnly>
	)
}
