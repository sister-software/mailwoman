/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Prints a CJK board read. The check line states the blended fraction and no other figure.
 */

import { pyFixed } from "@mailwoman/core/numeric"
import { codePointLength } from "@mailwoman/core/strings/code-points"
import { compareByScalarValue } from "@mailwoman/core/strings/compare"

import { ACCEPT_KM, type BoardResult, CHECK } from "#tools/eval-harness/cjk/board/score"

export interface BoardReportOptions {
	acceptKm?: number
	check?: number
	/**
	 * Lists every held-out municipality rather than the lowest five.
	 */
	allMunicipalities?: boolean
}

/**
 * `text` padded with spaces to `width` code points, as Python's `:<width` pads.
 */
function padCodePoints(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - codePointLength(text)))
}

/**
 * The printed read, line for line as the Python board printed it.
 */
export function formatBoardReport(result: BoardResult, options: BoardReportOptions = {}): string {
	const acceptKm = options.acceptKm ?? ACCEPT_KM
	const check = options.check ?? CHECK
	const fixed = (value: number) => pyFixed(value, 4)

	const lines = [
		`board rows: ${result.rows}; unresolved (pred pair not in table): ${result.unresolved}` +
			` (of which gold-exact, centroid within ${acceptKm} km by the row's own kanji: ${result.gold_exact_unresolved})`,
		"per-tag span exact-match:",
	]

	for (const tag of [...result.tag_total.keys()].toSorted(compareByScalarValue)) {
		const total = result.tag_total.get(tag)!
		const hit = result.tag_hit.get(tag) ?? 0

		lines.push(`  ${padCodePoints(tag, 16)} ${fixed(hit / total)}  (${hit}/${total})`)
	}

	lines.push("")

	if (result.per_register.size) {
		lines.push(`per-register acceptability (<= ${acceptKm} km) — DIAGNOSTIC, not the check:`)

		for (const [name, stats] of [...result.per_register].toSorted(([, left], [, right]) => right.rows - left.rows)) {
			lines.push(
				`  ${padCodePoints(name, 16)} ${fixed(stats.fraction)}  (${stats.acceptable}/${stats.rows})  unresolved ${stats.unresolved}` +
					` (gold-exact ${stats.gold_exact})`
			)
		}
	} else {
		lines.push("per-register acceptability: board carries no `register` column — no breakdown.")
	}

	if (result.per_municipality.size) {
		const ordered = [...result.per_municipality].toSorted(
			([, left], [, right]) => left.fraction - right.fraction || right.rows - left.rows
		)

		lines.push(
			"",
			`municipality macro (mean of per-municipality acceptability over ${result.per_municipality.size} held-out ` +
				`municipalities) — a READING beside the blended check: ${fixed(result.municipality_macro)}`,
			"  lowest five (name, acceptable/rows):"
		)

		for (const [name, stats] of ordered.slice(0, 5)) {
			lines.push(`    ${padCodePoints(name, 12)} ${fixed(stats.fraction)}  (${stats.acceptable}/${stats.rows})`)
		}

		if (options.allMunicipalities) {
			lines.push("  every held-out municipality (name, acceptable/rows, gold-exact among unresolved):")

			for (const [name, stats] of ordered) {
				lines.push(
					`    ${padCodePoints(name, 12)} ${fixed(stats.fraction)}  (${stats.acceptable}/${stats.rows})` +
						`  gold-exact ${stats.gold_exact}`
				)
			}
		}
	}

	lines.push(
		"",
		`COORD-ACCEPTABILITY (<= ${acceptKm} km): ${fixed(result.fraction)}  (${result.acceptable}/${result.rows})`,
		`CHECK >= ${pyFixed(check, 2)}: ${result.fraction >= check ? "PASS" : "FAIL"}`
	)

	return lines.join("\n")
}
