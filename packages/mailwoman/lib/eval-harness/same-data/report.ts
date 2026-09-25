/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders the same-data benchmark's Markdown tables from generated results.
 *
 *   Every rate prints its denominator. A rate with a zero denominator prints as `unmeasured`.
 */

import { renderMarkdownTable } from "@mailwoman/core/strings/markdown-table"

import type { ArmRowResult } from "#eval-harness/same-data/arms"
import type { SameDataPanelRow } from "#eval-harness/same-data/fixture"
import {
	armMetrics,
	type ArmMetrics,
	type BenchmarkVerdict,
	type PairedComparison,
	type Ratio,
	type ReliabilityBin,
} from "#eval-harness/same-data/score"
import type { ThresholdDecision, ThresholdPoint } from "#eval-harness/same-data/threshold"

/**
 * Formats a rate as a percentage with its numerator and denominator, or as `unmeasured`.
 */
export function renderRatio({ numerator, denominator, value }: Ratio): string {
	if (value === null) return "unmeasured"

	return `${(100 * value).toFixed(1)}% (${numerator}/${denominator})`
}

/**
 * Renders per-stratum metrics for every arm, followed by a pooled row per arm.
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
		renderRatio(metrics.selectionAccuracy),
		renderRatio(metrics.wrongArea),
		`${(100 * (metrics.mechanismCoverage.value ?? 0)).toFixed(1)}%`,
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
 * Renders the abstention metrics for the withheld-gold stratum, the only stratum where they apply.
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

		return [arm, String(metrics.n), renderRatio(metrics.abstentionPrecision), renderRatio(metrics.falseSelection)]
	})

	return renderMarkdownTable(["arm", "n", "abstention precision", "false-selection rate"], rows)
}

/**
 * Renders one paired comparison, including the discordant counts behind the test.
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
 * Renders the reliability table for one arm.
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
 * Renders the registered decision with the observed value for each condition.
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
 * Renders one arm's abstention-threshold curve.
 *
 * Each row shows the false-selection rate on withheld-gold rows next to the accuracy on rows with a gold.
 */
export function renderThresholdCurve(arm: string, curve: readonly ThresholdPoint[]): string[] {
	const rows = curve.map((point) => [
		point.threshold.toFixed(2),
		String(point.withheld),
		String(point.metrics.selections),
		renderRatio(point.metrics.selectionAccuracy),
		renderRatio(point.metrics.wrongArea),
		renderRatio(point.metrics.falseSelection),
	])

	return [
		`**${arm}**`,
		"",
		...renderMarkdownTable(
			["threshold", "withheld", "selections", "selection accuracy", "wrong-area rate", "false-selection rate"],
			rows
		),
	]
}

/**
 * Renders the registered decision rule evaluated at each threshold.
 */
export function renderThresholdDecisions(decisions: readonly ThresholdDecision[]): string[] {
	const rows = decisions.map(({ threshold, verdict }) => [
		threshold.toFixed(2),
		`${verdict.marginPoints.toFixed(1)} points`,
		verdict.pValue.toExponential(3),
		!verdict.regressions.length ? "none" : verdict.regressions.join("; "),
		verdict.passed ? "yes" : "no",
	])

	return renderMarkdownTable(
		["threshold", "pooled margin", "exact McNemar p", "per-stratum regressions", "rule would read"],
		rows.length ? rows : [["—", "—", "—", "—", "no threshold dominates the baseline"]]
	)
}

/**
 * Renders up to `limit` rows that the baseline got right and Mailwoman got wrong.
 *
 * The table shows each row's query, gold, both selections, and Mailwoman's mechanism
 * so a reader can audit the losses.
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
