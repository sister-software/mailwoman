/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The same-data benchmark's tables (#2261), rendered from generated results so the published record is
 *   never typed by hand — the self-reporting rule `oa/resolver/eval.ts` states for every eval here.
 *
 *   NOT THE HOMOGRAPH SCORER NEXT DOOR. `eval-harness/score/country-homograph.ts` grades the CLASSIFIER's
 *   country/region/locality tagging on a homograph corpus. This grades the RESOLVER's selection from a
 *   frozen candidate set. They share a word and measure different layers; neither subsumes the other.
 *
 *   EVERY RATE PRINTS ITS DENOMINATOR, and an unmeasured rate prints as `unmeasured` rather than as zero. A
 *   wrong-area rate over no coordinate-bearing selection is not 0%; it is a rate nobody could compute, and
 *   the two must not read the same.
 *
 *   THE LOSSES ARE PART OF THE REPORT. `renderLosses` lists the rows the baseline won and Mailwoman did
 *   not, with the query in view — a record that prints only the aggregate cannot be audited, and the rows
 *   where the simpler resolver wins are the ones worth reading.
 */

import { renderMarkdownTable } from "@mailwoman/core/strings/markdown-table"

import type { ArmRowResult } from "#eval-harness/same-data/arms"
import type { SameDataPanelRow } from "#eval-harness/same-data/fixture"
import {
	armMetrics,
	type ArmMetrics,
	type BenchmarkVerdict,
	type PairedComparison,
	type ReliabilityBin,
} from "#eval-harness/same-data/score"

/**
 * A rate as a percentage with its denominator, or the word that says nobody could measure it.
 */
function rate(value: number | null, denominator: number): string {
	if (value === null) return "unmeasured"

	return `${(100 * value).toFixed(1)}% (${Math.round(value * denominator)}/${denominator})`
}

/**
 * Per-stratum metrics for every arm, plus the pooled row.
 */
export function renderMetricsTable(
	panel: readonly SameDataPanelRow[],
	results: readonly ArmRowResult[],
	arms: readonly string[]
): string[] {
	const panelByID = new Map(panel.map((row) => [row.id, row]))
	const strata = [...new Set(panel.map((row) => row.stratum))]
	const rows: string[][] = []

	const toRow = (metrics: ArmMetrics, label: string): string[] => [
		label,
		metrics.arm,
		String(metrics.n),
		String(metrics.errors),
		String(metrics.selections),
		String(metrics.abstentions),
		rate(metrics.selectionAccuracy, metrics.n - metrics.errors),
		rate(metrics.wrongAreaRate, metrics.wrongAreaMeasured),
		`${(100 * metrics.mechanismCoverage).toFixed(1)}%`,
	]

	for (const stratum of strata) {
		for (const arm of arms) {
			const scoped = results.filter((result) => result.arm === arm && result.stratum === stratum)

			rows.push(toRow(armMetrics(arm, stratum, panelByID, scoped), stratum))
		}
	}

	for (const arm of arms) {
		rows.push(
			toRow(
				armMetrics(
					arm,
					"pooled",
					panelByID,
					results.filter((result) => result.arm === arm)
				),
				"**pooled**"
			)
		)
	}

	return renderMarkdownTable(
		[
			"stratum",
			"arm",
			"n",
			"errors",
			"selections",
			"abstentions",
			"selection accuracy",
			"wrong-area rate",
			"mechanism coverage",
		],
		rows
	)
}

/**
 * The abstention metrics, which only the withheld-gold stratum can carry. Reported apart so an absent-candidate failure
 * mode is never pooled away.
 */
export function renderAbstentionTable(
	panel: readonly SameDataPanelRow[],
	results: readonly ArmRowResult[],
	arms: readonly string[]
): string[] {
	const panelByID = new Map(panel.map((row) => [row.id, row]))
	const stratum = panel.find((row) => !row.goldPresent)?.stratum ?? "gold_absent"

	const rows = arms.map((arm) => {
		const scoped = results.filter((result) => result.arm === arm && result.stratum === stratum)
		const metrics = armMetrics(arm, stratum, panelByID, scoped)

		return [
			arm,
			String(metrics.n),
			rate(metrics.abstentionPrecision, metrics.n),
			rate(metrics.falseSelectionRate, metrics.n),
		]
	})

	return renderMarkdownTable(["arm", "n", "abstention precision", "false-selection rate"], rows)
}

/**
 * One paired comparison, with the discordant counts that drive the test rather than only its verdict.
 */
export function renderPairedComparison(label: string, comparison: PairedComparison): string[] {
	return [
		`**${label}** — ${comparison.n} paired rows.`,
		"",
		...renderMarkdownTable(
			["quantity", "value"],
			[
				["difference in accuracy", `${(100 * comparison.difference).toFixed(1)} points`],
				[
					"95% paired-bootstrap interval",
					`${(100 * comparison.intervalLow).toFixed(1)} to ${(100 * comparison.intervalHigh).toFixed(1)} points`,
				],
				["first arm only correct", String(comparison.firstOnly)],
				["second arm only correct", String(comparison.secondOnly)],
				["both correct", String(comparison.bothCorrect)],
				["neither correct", String(comparison.neitherCorrect)],
				["exact McNemar p", comparison.pValue.toExponential(3)],
				["bootstrap resamples / seed", `${comparison.resamples} / ${comparison.seed}`],
			]
		),
	]
}

/**
 * The reliability table for one arm.
 */
export function renderReliability(arm: string, bins: readonly ReliabilityBin[]): string[] {
	const rows = bins.map((bin) => [
		`[${bin.low.toFixed(1)}, ${bin.high.toFixed(1)})`,
		String(bin.count),
		bin.accuracy === null ? "unmeasured" : `${(100 * bin.accuracy).toFixed(1)}%`,
	])

	return [`**${arm}**`, "", ...renderMarkdownTable(["confidence bin", "count", "accuracy"], rows)]
}

/**
 * The registered decision, with the quantity that decided it beside each condition.
 */
export function renderDecisionTable(verdict: BenchmarkVerdict): string[] {
	return [
		...renderMarkdownTable(
			["condition", "required", "observed", "met"],
			[
				[
					"pooled margin",
					`at least ${verdict.requiredMarginPoints.toFixed(1)} points`,
					`${verdict.marginPoints.toFixed(1)} points`,
					verdict.marginMet ? "yes" : "no",
				],
				["exact McNemar", "p at most 0.05", verdict.pValue.toExponential(3), verdict.significanceMet ? "yes" : "no"],
				[
					"no per-stratum regression",
					"none",
					!verdict.regressions.length ? "none" : verdict.regressions.join("; "),
					!verdict.regressions.length ? "yes" : "no",
				],
			]
		),
		"",
		`**Verdict: ${verdict.passed ? "the registered claim holds" : "the registered claim does NOT hold"}.**`,
	]
}

/**
 * The rows the baseline got right and Mailwoman did not, with the query in view.
 *
 * A record that prints only aggregates cannot be audited, and these are the rows worth reading: a deterministic
 * resolver with no fame term beating the production one names a mechanism, not a rounding difference.
 */
export function renderLosses(
	panel: readonly SameDataPanelRow[],
	results: readonly ArmRowResult[],
	limit: number
): string[] {
	const panelByID = new Map(panel.map((row) => [row.id, row]))
	const byRow = new Map<string, Map<string, ArmRowResult>>()

	for (const result of results) {
		const bucket = byRow.get(result.rowID) ?? new Map<string, ArmRowResult>()

		bucket.set(result.arm, result)
		byRow.set(result.rowID, bucket)
	}

	const rows: string[][] = []

	for (const [rowID, arms] of byRow) {
		if (rows.length >= limit) break

		const baseline = arms.get("baseline")
		const mailwoman = arms.get("mailwoman")
		const row = panelByID.get(rowID)

		if (!row || !baseline || !mailwoman) continue

		if (!baseline.correct || mailwoman.correct) continue

		rows.push([
			rowID,
			`\`${row.query}\``,
			`${row.gold.name} (${row.gold.country}) ${row.gold.placeIDs.join("/")}`,
			baseline.selection ?? "abstained",
			mailwoman.selection ?? "abstained",
			mailwoman.mechanism ?? "none",
		])
	}

	if (!rows.length) {
		rows.push(["—", "—", "—", "—", "—", "no row the baseline won and Mailwoman lost"])
	}

	return renderMarkdownTable(
		["row", "query", "gold", "baseline picked", "mailwoman picked", "mailwoman mechanism"],
		rows
	)
}
