/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Transforms an existing linear-scale training-chart SVG into a log10-scale version. Reads the
 *   pixel coordinates from path/circle elements, reverses the linear mapping using the axis tick
 *   labels, applies log10, and writes a new SVG with log-scale axis labels and grid.
 *
 *   Usage:
 *
 *   Node --experimental-strip-types scripts/log-scale-chart.ts\
 *   --input docs/articles/evals/charts/v06x-val-loss.svg\
 *   --output docs/articles/evals/charts/v06x-val-loss-log.svg
 */

import { readFileSync, writeFileSync } from "node:fs"

interface Args {
	input: string
	output: string
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Partial<Args> = {}
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--input" && args[i + 1]) out.input = args[++i]
		else if (a === "--output" && args[i + 1]) out.output = args[++i]
	}
	if (!out.input || !out.output) {
		console.error("Usage: log-scale-chart.ts --input <svg> --output <svg>")
		process.exit(1)
	}
	return out as Args
}

// Extract numeric tick values from the y-axis labels in the SVG.
// The generator places <text> elements just left of the left padding edge.
function extractYTicks(svg: string): number[] {
	const ticks: number[] = []
	// Y-axis tick labels: <text x="64" y="...">value</text>
	const re = /<text x="64" y="([\d.]+)"[^>]*>([\d.]+)<\/text>/g
	let m: RegExpExecArray | null
	while ((m = re.exec(svg)) !== null) {
		ticks.push(parseFloat(m[2]!))
	}
	return ticks.sort((a, b) => a - b)
}

function fmt(n: number): string {
	if (Math.abs(n) >= 1000) return n.toLocaleString()
	if (Math.abs(n) >= 1) return n.toFixed(3).replace(/\.?0+$/, "")
	return n.toFixed(3)
}

function niceTicksLog(min: number, max: number): number[] {
	// For log scale, ticks are powers of 10 and their multiples
	const ticks: number[] = []
	const lo = Math.floor(min)
	const hi = Math.ceil(max)
	for (let exp = lo; exp <= hi; exp++) {
		ticks.push(Math.pow(10, exp))
	}
	// Add intermediate ticks (2×, 5×)
	const iticks: number[] = []
	for (let exp = lo; exp <= hi; exp++) {
		const base = Math.pow(10, exp)
		for (const m of [2, 3, 5, 7]) {
			const v = m * base
			if (v >= Math.pow(10, min) && v <= Math.pow(10, max)) {
				iticks.push(v)
			}
		}
	}
	ticks.push(...iticks)
	return ticks.sort((a, b) => a - b)
}

function transformSVG(svg: string): string {
	const padding = { top: 50, right: 200, bottom: 50, left: 70 }
	const W = 720
	const H = 380
	const plotW = W - padding.left - padding.right
	const plotH = H - padding.top - padding.bottom

	// Extract original y-axis ticks to discover yMin/yMax
	const yTicks = extractYTicks(svg)
	if (yTicks.length < 2) throw new Error("Could not extract y-axis ticks from SVG")
	const yMin = yTicks[0]!
	const yMax = yTicks[yTicks.length - 1]!

	// Log range
	const logMin = Math.log10(Math.max(yMin, 1e-9))
	const logMax = Math.log10(yMax)

	// Build inverse mapping function: pixelY → original value → log value → new pixelY
	const pixelToValue = (py: number) => yMin + ((padding.top + plotH - py) / plotH) * (yMax - yMin)
	const valueToLogPixel = (v: number) =>
		padding.top + plotH - ((Math.log10(Math.max(v, yMin * 1e-3)) - logMin) / (logMax - logMin)) * plotH

	// Transform all y-coordinates in path data
	let result = svg.replace(/([ML])([\d.]+),([\d.]+)/g, (_, cmd: string, xStr: string, yStr: string) => {
		const y = parseFloat(yStr)
		const newY = valueToLogPixel(pixelToValue(y))
		return `${cmd}${xStr},${newY.toFixed(1)}`
	})

	// Transform y-coordinates in circle elements
	result = result.replace(/cy="([\d.]+)"/g, (_, yStr: string) => {
		const y = parseFloat(yStr)
		const newY = valueToLogPixel(pixelToValue(y))
		return `cy="${newY.toFixed(1)}"`
	})

	// Transform y-coordinates in grid lines and y-axis tick text positions
	result = result.replace(
		/<line x1="70" y1="([\d.]+)" x2="520" y2="[\d.]+" stroke="#e5e7eb"[^>]*\/>/g,
		(_, y1Str: string, y2Str: string) => {
			const y1 = parseFloat(y1Str)
			const newY = valueToLogPixel(pixelToValue(y1))
			return `<line x1="70" y1="${newY.toFixed(1)}" x2="520" y2="${newY.toFixed(1)}" stroke="#e5e7eb"`
		}
	)

	// Replace the y-axis label text. The pattern is: <text x="64" y="Y">VALUE</text>
	// We need to replace ALL y-axis labels with log-scale ones.
	// First, remove all old y-tick labels and grid lines
	result = result.replace(/<text x="64" y="[\d.]+"[^>]*>[\d.]+<\/text>/g, "")
	result = result.replace(/<line x1="70" y1="[\d.]+" x2="520" y2="[\d.]+" stroke="#e5e7eb"[^>]*\/>/g, "")
	result = result.replace(/<line x1="72" y1="[\d.]+" x2="518" y2="[\d.]+" stroke="#e5e7eb"[^>]*\/>/g, "")

	// Generate new log-scale ticks and insert them
	const logTicks = niceTicksLog(logMin, logMax)
	const newYElements: string[] = []
	for (const t of logTicks) {
		const v = Math.log10(t)
		const py = padding.top + plotH - ((v - logMin) / (logMax - logMin)) * plotH
		if (py < padding.top || py > padding.top + plotH) continue
		newYElements.push(
			`<line x1="70" y1="${py.toFixed(1)}" x2="520" y2="${py.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" />`
		)
		newYElements.push(`<text x="64" y="${(py + 3).toFixed(1)}" text-anchor="end">${fmt(t)}</text>`)
	}

	// Insert new grid lines and labels BEFORE the plot border rect
	const borderMarker = '<rect x="70" y="50" width="'
	const replacement = newYElements.join("\n") + "\n" + borderMarker
	result = result.replace(borderMarker, replacement)

	// Update plot border to still be correctly positioned
	// (unchanged since plot area doesn't move)

	// Add "(log scale)" note near the y-axis label
	const yLabelMarker = 'rotate(-90)" text-anchor="middle" font-size="12">'
	const logLabelReplacement = yLabelMarker + "(log scale) "
	result = result.replace(yLabelMarker, logLabelReplacement)

	return result
}

function main(): void {
	const args = parseArgs()
	const svg = readFileSync(args.input, "utf8")
	const transformed = transformSVG(svg)
	writeFileSync(args.output, transformed)
	console.error(`Wrote log-scale chart: ${args.output}`)
}

main()
