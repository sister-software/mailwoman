/**
 * Mailwoman Eval Viewer Extension
 *
 * Registers /eval-viewer command that opens an interactive overlay displaying the latest parity scorecard as a sortable
 * table with regression highlighting.
 *
 * Pattern from: overlay-test.ts (overlay command), questionnaire.ts (interactive)
 */

import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

const PROJECT_ROOT = process.cwd()

// ---- Scorecard types ----

interface ScoreRow {
	tag: string
	eval: string
	versions: { version: string; value: number | null; isBold: boolean }[]
}

interface ParsedScorecard {
	date: string
	rows: ScoreRow[]
	versionHeaders: string[]
}

// ---- Markdown table parser ----

function parseScorecard(markdown: string): ParsedScorecard | null {
	const lines = markdown.split("\n")

	// Extract date from header
	const dateMatch = markdown.match(/Parity Scorecard[—-]\s*(\d{4}-\d{2}-\d{2})/)
	const date = dateMatch ? dateMatch[1] : "unknown"

	// Find Lens 2 table
	let tableStart = -1

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes("Lens 2") || lines[i].includes("per-tag")) {
			// Scan forward for the table header
			for (let j = i + 1; j < lines.length && j < i + 8; j++) {
				if (lines[j].startsWith("| tag")) {
					tableStart = j
					break
				}
			}
			break
		}
	}

	if (tableStart === -1) return null

	// Parse header row
	const headerCells = lines[tableStart]
		.split("|")
		.map((c) => c.trim())
		.filter(Boolean)

	// Version columns start at index 2 (after tag, eval)
	const versionHeaders = headerCells.slice(2).map((h) => h.replace(/\*\*/g, ""))

	// Parse data rows — skip separator, parse until we hit a blank line or non-table content
	const rows: ScoreRow[] = []

	for (let i = tableStart + 2; i < lines.length; i++) {
		const line = lines[i].trim()

		if (!line.startsWith("|")) break

		const cells = line
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean)

		if (cells.length < 3) continue

		const tag = cells[0]
		const evalDesc = cells[1]

		const versions = cells.slice(2).map((cell, idx) => {
			const boldMatch = cell.match(/^\*\*(.+)\*\*$/)
			const isBold = boldMatch !== null
			const raw = isBold ? boldMatch[1] : cell
			const value = raw === "—" || raw === "" ? null : parseFloat(raw)

			return {
				version: versionHeaders[idx] || `v${idx}`,
				value: isNaN(value as number) ? null : value,
				isBold,
			}
		})

		rows.push({ tag, eval: evalDesc, versions })
	}

	return { date, rows, versionHeaders }
}

function findLatestScorecard(): string | null {
	// Scorecards live under the competitive-parity topic subdir since the 2026-07-14 evals reorg.
	const evalsDir = resolve(PROJECT_ROOT, "docs/articles/evals/competitive-parity")
	let files: string[]

	try {
		files = readdirSync(evalsDir)
	} catch {
		return null
	}

	const scorecards = files
		.filter((f) => f.startsWith("parity-scorecard-") && f.endsWith(".md"))
		.sort()
		.reverse()

	if (scorecards.length === 0) return null

	return resolve(evalsDir, scorecards[0])
}

function readScorecard(path: string): ParsedScorecard | null {
	try {
		const content = readFileSync(path, "utf-8")

		return parseScorecard(content)
	} catch {
		return null
	}
}

// ---- Eval Viewer Component ----

type SortKey = "tag" | "delta"

class EvalViewerComponent {
	private rows: ScoreRow[]
	private date: string
	private versionHeaders: string[]
	private selected = 0
	private sortKey: SortKey = "tag"
	private sortAsc = true
	private cachedWidth?: number
	private cachedLines?: string[]

	private theme: Theme
	private done: () => void

	constructor(scorecard: ParsedScorecard, theme: Theme, done: () => void) {
		this.rows = scorecard.rows
		this.date = scorecard.date
		this.versionHeaders = scorecard.versionHeaders
		this.theme = theme
		this.done = done
		this.sort()
	}

	private getDelta(row: ScoreRow): number | null {
		const vals = row.versions.filter((v) => v.value !== null).map((v) => v.value!)

		if (vals.length < 2) return null

		// Delta = latest - previous (positive = improvement)
		return vals[vals.length - 1] - vals[vals.length - 2]
	}

	private sort(): void {
		this.rows.sort((a, b) => {
			let cmp = 0

			if (this.sortKey === "tag") {
				cmp = a.tag.localeCompare(b.tag)
			} else {
				const da = this.getDelta(a)
				const db = this.getDelta(b)

				if (da === null && db === null) cmp = 0
				else if (da === null) cmp = 1
				else if (db === null) cmp = -1
				else cmp = da - db
			}

			return this.sortAsc ? cmp : -cmp
		})
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up) && this.selected > 0) {
			this.selected--
			this.invalidate()
		} else if (matchesKey(data, Key.down) && this.selected < this.rows.length - 1) {
			this.selected++
			this.invalidate()
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			this.sortKey = this.sortKey === "tag" ? "delta" : "tag"
			this.sortAsc = !this.sortAsc
			this.sort()
			this.selected = 0
			this.invalidate()
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
			this.done()
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines
		}

		const lines: string[] = []
		const t = this.theme
		const innerWidth = Math.min(width - 4, 100)

		// Header
		const title = `Parity Scorecard — ${this.date}`
		const padded = "  " + title + " ".repeat(Math.max(0, innerWidth - visibleWidth(title) - 2))
		lines.push(t.bg("toolPendingBg", t.fg("accent", t.bold(padded))))
		lines.push("")

		// Column headers
		const colWidths = this.computeColumnWidths(innerWidth)
		const headerLine = this.formatRow(
			["Tag", "Eval", ...this.versionHeaders.map((h) => (h.startsWith("v") ? h : h.slice(0, 10)))],
			colWidths,
			t.fg("muted", t.bold)
		)
		lines.push(headerLine)

		// Separator
		const sep = colWidths.map((w) => "─".repeat(w)).join("─┼─")
		lines.push(t.fg("borderMuted", `  ${sep}`))

		// Data rows
		const maxRows = Math.min(this.rows.length, innerWidth > 60 ? 20 : 12)
		const startIdx = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), this.rows.length - maxRows))

		for (let i = startIdx; i < Math.min(startIdx + maxRows, this.rows.length); i++) {
			const row = this.rows[i]
			const isSelected = i === this.selected
			const delta = this.getDelta(row)

			const deltaStr = delta !== null ? (delta >= 0 ? "+" : "") + delta.toFixed(1) : "—"

			const valueStrs = row.versions.map((v) => (v.value !== null ? v.value.toFixed(1) : "—"))

			// Determine row color based on delta
			let rowColor = (s: string) => s

			if (delta !== null && Math.abs(delta) > 2) {
				rowColor = delta >= 0 ? t.fg("success") : t.fg("error")
			}

			const prefix = isSelected ? "> " : "  "
			const cells = [prefix + row.tag, row.eval.slice(0, 20), ...valueStrs.slice(0, 3)]

			let line = this.formatRow(cells, colWidths, rowColor)

			// Show delta for last column
			if (delta !== null) {
				const deltaColor = delta >= 0 ? t.fg("success") : t.fg("error")
				line += "  " + deltaColor(deltaStr)
			}

			if (isSelected) {
				line = t.bg("selectedBg", line)
			}

			lines.push(truncateToWidth(line, width))
		}

		// Footer
		lines.push("")
		const footer = t.fg(
			"muted",
			`↑↓ navigate  ←→ sort (${this.sortKey} ${this.sortAsc ? "↑" : "↓"})  ↵/esc close  ` +
				`${startIdx + 1}-${Math.min(startIdx + maxRows, this.rows.length)} of ${this.rows.length}`
		)
		lines.push(truncateToWidth("  " + footer, width))

		this.cachedLines = lines
		this.cachedWidth = width

		return lines
	}

	private computeColumnWidths(available: number): number[] {
		const tagWidth = 22
		const evalWidth = 24
		const versionCount = Math.min(this.versionHeaders.length, 3)
		const remaining = available - tagWidth - evalWidth - 4
		const versionWidth = Math.max(10, Math.floor(remaining / versionCount))

		return [tagWidth, evalWidth, ...Array(versionCount).fill(versionWidth)]
	}

	private formatRow(cells: string[], widths: number[], color: (s: string) => string): string {
		const parts = cells.slice(0, widths.length).map((c, i) => {
			const w = widths[i]
			const vis = visibleWidth(c)

			if (vis > w) return c.slice(0, Math.max(0, w - 1)) + "…"

			return c + " ".repeat(w - vis)
		})

		return color(parts.join(" │ "))
	}

	invalidate(): void {
		this.cachedWidth = undefined
		this.cachedLines = undefined
	}
}

// ---- Extension ----

export default function (pi: ExtensionAPI) {
	pi.registerCommand("eval-viewer", {
		description: "Open interactive parity scorecard viewer",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/eval-viewer requires TUI mode", "error")

				return
			}

			const scorecardPath = findLatestScorecard()

			if (!scorecardPath) {
				ctx.ui.notify("No parity scorecards found in docs/articles/evals/competitive-parity/", "error")

				return
			}

			const scorecard = readScorecard(scorecardPath)

			if (!scorecard || scorecard.rows.length === 0) {
				ctx.ui.notify(`Failed to parse scorecard: ${scorecardPath}`, "error")

				return
			}

			await ctx.ui.custom<undefined>(
				(_tui, theme, _keybindings, done) => new EvalViewerComponent(scorecard, theme, () => done(undefined)),
				{
					overlay: true,
					overlayOptions: {
						width: "85%",
						minWidth: 60,
					},
				}
			)
		},
	})
}
