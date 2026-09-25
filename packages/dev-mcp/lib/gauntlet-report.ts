/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Extracts the header counts, verdict, pins line and firing count from a gauntlet log.
 *
 *   This module only reads the log and never regrades it. A field whose line is missing stays `null`, and
 *   `unparsed` records why. The parser never substitutes a default such as `0`.
 */

interface GauntletLayerReport {
	layer: string
	counted_pass: number
	counted_total: number
	tracked: number
}

/**
 * The lines extracted from one gauntlet run.
 */
export interface GauntletReport {
	/**
	 * `PASS` or `FAIL` as the run printed it, or `null` when the run crashed or stopped before a verdict.
	 * A missing verdict is kept apart from `FAIL`.
	 */
	verdict: string | null
	layers: GauntletLayerReport[]
	/**
	 * The `describeResolverPins` line, verbatim.
	 */
	pins: string | null
	/**
	 * The firing count of the postcode-country coherence pass, or `null` when the log has no firing line.
	 *
	 * Only that pass prints a firing count.
	 * The field makes no statement about any other pinned pass.
	 */
	postcode_country_coherence_fired_on: { n: number; of: number } | null
	/**
	 * The counted failures, verbatim and in log order.
	 */
	counted_failures: string[]
	/**
	 * The tracked rows that now pass and could be promoted.
	 */
	now_passing: string[]
	/**
	 * Notes on each field that could not be extracted.
	 */
	unparsed: string[]
}

/**
 * Line patterns whose quantifiers cannot overlap.
 *
 * The pins and promote lines use `startsWith` and `indexOf` instead, because a regex for
 * them needs an ambiguous quantifier that backtracks quadratically on long lines.
 */
const HEADER = /^=== Gauntlet · (\S+) \((\d+)\/(\d+) counted cases pass(?:, (\d+) tracked)?\)/
const VERDICT = /^verdict: (PASS|FAIL)/
const FIRING = /^postcode-country coherence fired on (\d+)\/(\d+) cases/

const PINS_PREFIX = "[gauntlet] "
const COUNTED_FAILURE_MARK = "✗"
const NOW_PASSING_MARK = " now PASSES"
const NOW_PASSING_PREFIX = "+"

/**
 * Parses a gauntlet run's output.
 *
 * The run prints its report to stdout and the pins line to stderr, so this function reads both.
 */
export function parseGauntletReport(stdout: string, stderr: string): GauntletReport {
	const report: GauntletReport = {
		verdict: null,
		layers: [],
		pins: null,
		postcode_country_coherence_fired_on: null,
		counted_failures: [],
		now_passing: [],
		unparsed: [],
	}

	// The job registry buffers the log and caps it at 8 MB.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded, already buffered
	for (const line of `${stderr}\n${stdout}`.split("\n")) {
		const header = HEADER.exec(line)

		if (header) {
			report.layers.push({
				layer: header[1]!,
				counted_pass: Number(header[2]),
				counted_total: Number(header[3]),
				tracked: header[4] ? Number(header[4]) : 0,
			})

			continue
		}

		const verdict = VERDICT.exec(line)

		if (verdict) {
			report.verdict = verdict[1]!

			continue
		}

		const firing = FIRING.exec(line)

		if (firing) {
			report.postcode_country_coherence_fired_on = { n: Number(firing[1]), of: Number(firing[2]) }

			continue
		}

		const trimmed = line.trim()

		if (trimmed.startsWith(COUNTED_FAILURE_MARK)) {
			report.counted_failures.push(trimmed.slice(COUNTED_FAILURE_MARK.length).trim())

			continue
		}

		// A promote line starts with `+ <id>`, followed by `NOW_PASSING_MARK`.
		if (trimmed.startsWith(NOW_PASSING_PREFIX)) {
			const marker = trimmed.indexOf(NOW_PASSING_MARK)

			if (marker > 0) {
				report.now_passing.push(trimmed.slice(NOW_PASSING_PREFIX.length, marker).trim())

				continue
			}
		}

		if (!report.pins && line.startsWith(PINS_PREFIX)) {
			const rest = line.slice(PINS_PREFIX.length).trim()

			// The pins line either mentions pins or contains an assignment.
			if (rest.toLowerCase().includes("pins") || rest.includes("=")) {
				report.pins = rest
			}
		}
	}

	if (!report.verdict) {
		report.unparsed.push(
			"No `verdict:` line found. The run did not reach a verdict — read the log rather than treating this as a FAIL."
		)
	}

	if (!report.layers.length) {
		report.unparsed.push(
			"No `=== Gauntlet · <layer> (n/m counted cases pass) ===` header found, so the pass counts and their denominator " +
				"are unknown. Do not read the absence of failures as a clean run."
		)
	}

	if (!report.pins) {
		report.unparsed.push("No pins line found, so the configuration this run graded is not recorded here.")
	}

	if (!report.postcode_country_coherence_fired_on) {
		report.unparsed.push(
			"No postcode-country coherence firing line found — that pass either did not run or spoke on no rows, and this " +
				"log cannot tell them apart. NOTE: no other pin prints a firing count, so a run pinning a different pin " +
				"carries no evidence here that it participated at all."
		)
	}

	return report
}

/**
 * Summarizes the report in one line.
 *
 * The line starts with the pass fraction because a reader compares that fraction against a baseline.
 */
export function summarizeGauntletReport(report: GauntletReport): string {
	if (!report.layers.length) {
		return `No counted header was found in this run's output, so there is no pass count to report. Verdict line: ${report.verdict ?? "absent"}. Read the log.`
	}

	const layers = report.layers
		.map((layer) => `${layer.layer} ${layer.counted_pass}/${layer.counted_total} counted`)
		.join("; ")

	const failures = report.counted_failures.length
		? ` ${report.counted_failures.length} counted failure${report.counted_failures.length === 1 ? "" : "s"}.`
		: ""

	const promotions = report.now_passing.length
		? ` ${report.now_passing.length} tracked row${report.now_passing.length === 1 ? "" : "s"} now pass and could be promoted.`
		: ""

	const fired = report.postcode_country_coherence_fired_on
		? ` Postcode-country coherence fired on ${report.postcode_country_coherence_fired_on.n}/${report.postcode_country_coherence_fired_on.of} rows` +
			" (that pass is the only one printing a firing count — it is not a reading on whatever pin you pinned)."
		: ""

	return `${layers}. Verdict ${report.verdict ?? "ABSENT"}.${failures}${promotions}${fired}`
}
