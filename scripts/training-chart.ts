/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   SVG line-chart generator for training-run metrics. Reads one or more parsed training-log JSON
 *   files (from `scripts/parse-training-log.ts`) and emits a comparison chart suitable for
 *   embedding in markdown docs.
 *
 *   No dependencies — generates raw SVG via template strings. Renders in Docusaurus, GitHub markdown
 *   preview, and any standalone HTML/markdown viewer.
 *
 *   Usage:
 *
 *   # Single run, val_loss curve:
 *
 *   Node --experimental-strip-types scripts/training-chart.ts\
 *   --input /tmp/v063.json --metric val_loss --output /tmp/v063-loss.svg
 *
 *   # Multi-run overlay (the operator's "same noise pattern" case):
 *
 *   Node --experimental-strip-types scripts/training-chart.ts\
 *   --input /tmp/v062.json --input /tmp/v062b.json --input /tmp/v063.json\
 *   --metric val_loss --title "v0.6.x training val_loss"\
 *   --output /tmp/v06x-loss-comparison.svg
 *
 *   The output SVG sets viewBox to be width-responsive when embedded; default width 720 for in-page
 *   layout.
 */

///<reference types="node" />

import { readFileSync, writeFileSync } from "node:fs"

interface TrainPoint {
	run: string
	step: number
	[metric: string]: number | string | undefined
}

// Metric name accepted as a string. Stage-3 per-tag F1 columns use the `f1.<tag>` form
// (e.g. `f1.locality`); plus the four canonical aggregate metrics.
type Metric = string

interface Args {
	inputs: string[]
	metric: Metric
	title?: string
	output: string
	width: number
	height: number
	yMin?: number
	yMax?: number
	log: boolean
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Partial<Args> = { inputs: [], width: 720, height: 380, log: false }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--input" && args[i + 1]) out.inputs!.push(args[++i])
		else if (a === "--metric" && args[i + 1]) out.metric = args[++i] as Metric
		else if (a === "--title" && args[i + 1]) out.title = args[++i]
		else if (a === "--output" && args[i + 1]) out.output = args[++i]
		else if (a === "--width" && args[i + 1]) out.width = Number(args[++i])
		else if (a === "--height" && args[i + 1]) out.height = Number(args[++i])
		else if (a === "--y-min" && args[i + 1]) out.yMin = Number(args[++i])
		else if (a === "--y-max" && args[i + 1]) out.yMax = Number(args[++i])
		else if (a === "--log") out.log = true
	}
	if (!out.inputs || out.inputs.length === 0 || !out.metric || !out.output) {
		console.error("Usage: training-chart.ts --input <json>... --metric val_loss|macro_f1|train_loss --output <svg>")
		process.exit(1)
	}
	return out as Args
}

const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#9333ea", "#0891b2"]

interface RunSeries {
	run: string
	color: string
	points: Array<[number, number]> // [step, value]
}

function loadAndGroup(args: Args): RunSeries[] {
	const byRun = new Map<string, Array<[number, number]>>()
	for (const path of args.inputs) {
		const data: TrainPoint[] = JSON.parse(readFileSync(path, "utf8"))
		for (const p of data) {
			const v = p[args.metric] as number | string | undefined
			if (typeof v !== "number") continue
			let arr = byRun.get(p.run)
			if (!arr) {
				arr = []
				byRun.set(p.run, arr)
			}
			arr.push([p.step, v])
		}
	}
	let i = 0
	const series: RunSeries[] = []
	for (const [run, points] of byRun) {
		points.sort((a, b) => a[0] - b[0])
		series.push({ run, color: PALETTE[i % PALETTE.length]!, points })
		i++
	}
	return series
}

function niceTicks(min: number, max: number, count = 5): number[] {
	const span = max - min
	if (span <= 0) return [min]
	const raw = span / count
	const exp = Math.floor(Math.log10(raw))
	const base = Math.pow(10, exp)
	const candidates = [1, 2, 2.5, 5, 10]
	let step = base
	for (const c of candidates) {
		if (c * base >= raw) {
			step = c * base
			break
		}
	}
	const ticks: number[] = []
	const start = Math.ceil(min / step) * step
	for (let v = start; v <= max + 1e-9; v += step) {
		// Trim floating-point drift
		ticks.push(Math.round(v / step) * step)
	}
	return ticks
}

function fmt(n: number): string {
	if (Math.abs(n) >= 1000) return n.toLocaleString()
	if (Math.abs(n) >= 1) return n.toFixed(3).replace(/\.?0+$/, "")
	return n.toFixed(3)
}

function renderSVG(args: Args, series: RunSeries[]): string {
	const padding = { top: 50, right: 200, bottom: 50, left: 70 }
	const W = args.width
	const H = args.height
	const plotW = W - padding.left - padding.right
	const plotH = H - padding.top - padding.bottom

	// Compute axis ranges.
	let xMin = Infinity
	let xMax = -Infinity
	let yMin = Infinity
	let yMax = -Infinity
	for (const s of series) {
		for (const [x, y] of s.points) {
			if (x < xMin) xMin = x
			if (x > xMax) xMax = x
			if (y < yMin) yMin = y
			if (y > yMax) yMax = y
		}
	}
	if (args.yMin !== undefined) yMin = args.yMin
	if (args.yMax !== undefined) yMax = args.yMax

	// Pad the Y range a touch so the lines don't graze the plot edges.
	const ySpan = yMax - yMin
	if (args.yMin === undefined) yMin -= ySpan * 0.05
	if (args.yMax === undefined) yMax += ySpan * 0.05

	// Log-scale transformation: map y through log10, then to pixel space.
	// Clamp near-zero values to avoid -Infinity.
	const logYMin = Math.log10(Math.max(yMin, 1e-9))
	const logYMax = Math.log10(yMax)
	const logYSpan = logYMax - logYMin
	const xToPx = (x: number) => padding.left + ((x - xMin) / (xMax - xMin)) * plotW
	const yToPx = (y: number) => {
		if (!args.log) return padding.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH
		const logY = Math.log10(Math.max(y, yMin > 0 ? yMin * 1e-3 : 1e-9))
		return padding.top + plotH - ((logY - logYMin) / logYSpan) * plotH
	}

	const xTicks = niceTicks(xMin, xMax, 6)
	const yTicks = args.log
		? (() => {
				const ticks: number[] = []
				const lo = Math.floor(logYMin)
				const hi = Math.ceil(logYMax)
				for (let exp = lo; exp <= hi; exp++) {
					ticks.push(Math.pow(10, exp))
					for (const m of [2, 3, 5, 7]) {
						const v = m * Math.pow(10, exp)
						if (v >= Math.pow(10, logYMin) && v <= Math.pow(10, logYMax)) ticks.push(v)
					}
				}
				return ticks.sort((a, b) => a - b)
			})()
		: niceTicks(yMin, yMax, 5)

	const parts: string[] = []
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11">`
	)
	parts.push(`<rect width="${W}" height="${H}" fill="white" />`)

	// Title.
	if (args.title) {
		parts.push(
			`<text x="${W / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600">${escapeXml(args.title)}</text>`
		)
	}

	// Axis labels — the metric name itself is the label, with "(log scale)" appended if --log.
	const metricLabel = args.log ? args.metric + " (log scale)" : args.metric
	parts.push(
		`<text x="${padding.left + plotW / 2}" y="${H - 12}" text-anchor="middle" font-size="12">training step</text>`
	)
	parts.push(
		`<text transform="translate(20, ${padding.top + plotH / 2}) rotate(-90)" text-anchor="middle" font-size="12">${metricLabel}</text>`
	)

	// Grid + axis ticks.
	for (const t of yTicks) {
		const y = yToPx(t)
		if (y < padding.top || y > padding.top + plotH) continue
		parts.push(
			`<line x1="${padding.left}" y1="${y}" x2="${padding.left + plotW}" y2="${y}" stroke="#e5e7eb" stroke-width="1" />`
		)
		parts.push(`<text x="${padding.left - 6}" y="${y + 3}" text-anchor="end">${fmt(t)}</text>`)
	}
	for (const t of xTicks) {
		const x = xToPx(t)
		if (x < padding.left || x > padding.left + plotW) continue
		parts.push(
			`<line x1="${x}" y1="${padding.top + plotH}" x2="${x}" y2="${padding.top + plotH + 4}" stroke="#374151" stroke-width="1" />`
		)
		parts.push(`<text x="${x}" y="${padding.top + plotH + 18}" text-anchor="middle">${fmt(t)}</text>`)
	}

	// Plot border.
	parts.push(
		`<rect x="${padding.left}" y="${padding.top}" width="${plotW}" height="${plotH}" fill="none" stroke="#9ca3af" stroke-width="1" />`
	)

	// Series.
	for (const s of series) {
		if (s.points.length === 0) continue
		const d = s.points
			.map(([x, y], i) => `${i === 0 ? "M" : "L"}${xToPx(x).toFixed(1)},${yToPx(y).toFixed(1)}`)
			.join(" ")
		parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.5" stroke-linejoin="round" />`)
		// Small dots at data points for clarity at low cadence
		for (const [x, y] of s.points) {
			parts.push(`<circle cx="${xToPx(x).toFixed(1)}" cy="${yToPx(y).toFixed(1)}" r="2.5" fill="${s.color}" />`)
		}
	}

	// Legend.
	const legendX = padding.left + plotW + 12
	let legendY = padding.top + 8
	parts.push(`<text x="${legendX}" y="${legendY}" font-size="12" font-weight="600">runs</text>`)
	legendY += 18
	for (const s of series) {
		parts.push(
			`<line x1="${legendX}" y1="${legendY - 4}" x2="${legendX + 18}" y2="${legendY - 4}" stroke="${s.color}" stroke-width="2" />`
		)
		parts.push(
			`<text x="${legendX + 24}" y="${legendY}" font-size="11">${escapeXml(s.run)} (n=${s.points.length})</text>`
		)
		legendY += 16
	}

	parts.push(`</svg>\n`)
	return parts.join("")
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"']/g, (c) =>
		c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;"
	)
}

function main(): void {
	const args = parseArgs()
	const series = loadAndGroup(args)
	const svg = renderSVG(args, series)
	writeFileSync(args.output, svg)
	console.error(`Wrote ${args.output}: ${series.length} series, ${series.map((s) => s.points.length).join("/")} points`)
}

main()
