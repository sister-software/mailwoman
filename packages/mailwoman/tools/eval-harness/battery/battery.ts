/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Scores a baseline and candidate models on the frozen suites of {@linkcode BATTERY_SUITES}, tags each wrong row by
 *   cause, and renders the comparison as markdown.
 *
 *   A row is right when every field matches after joining street prefix, name and suffix, lowercasing, and dropping
 *   commas. On the `osm-` suites that matches the suite scorer's exact-match counts within 5 rows per suite and arm.
 *   On the `photon-` suites it is needed because their US labels keep the street whole.
 */

import { formatPercent } from "@mailwoman/core/stats"

import {
	BATTERY_CAUSES,
	type BatteryCause,
	type BatterySpan,
	batteryFieldKey,
	batteryFieldMap,
	classifyBatteryError,
} from "#tools/eval-harness/battery/classify"
import {
	type BatteryReportRow,
	formatFailureGroups,
	groupBatteryFailures,
} from "#tools/eval-harness/battery/failure-groups"
import {
	type BatterySuiteRow,
	type BatterySuiteSpec,
	CORRECTION_GROUPS,
	correctBatteryFields,
	LABEL_CONVENTION_GROUPS,
} from "#tools/eval-harness/battery/suites"

/**
 * One arm of a battery run.
 */
export interface BatteryArm {
	name: string
	/**
	 * The package-shaped weights cache the arm parses with.
	 */
	cache: string
}

/**
 * One row scored for every arm.
 */
export interface BatteryRowResult extends BatteryReportRow {
	/**
	 * Whether the arm was right before the corrections in {@linkcode CORRECTION_GROUPS} were applied.
	 */
	rightUncorrected: Record<string, boolean>
	corrections: Record<string, string[]>
	cause: Record<string, BatteryCause | null>
}

/**
 * A battery run: its arms, their roles, and every row by suite.
 */
export interface BatteryReport {
	arms: BatteryArm[]
	baseline: string
	seeds: string[]
	suites: Record<string, { rows: BatteryRowResult[] }>
}

/**
 * Scores one suite row for every arm, given each arm's parse of it.
 *
 * @throws When an arm has no parse of the row.
 */
export function scoreBatteryRow(
	spec: BatterySuiteSpec,
	row: BatterySuiteRow,
	arms: readonly string[],
	parseOf: (arm: string, sourceID: string) => readonly BatterySpan[] | undefined
): BatteryRowResult {
	const expectedFields = () =>
		batteryFieldMap(row.span_tags.map((tag, i) => [tag, row.raw.slice(row.span_starts[i], row.span_ends[i])] as const))

	const result: BatteryRowResult = {
		raw: row.raw,
		country: row.country,
		labelConvention: spec.labelConvention(row),
		expected: batteryFieldKey(expectedFields()),
		got: {},
		right: {},
		rightUncorrected: {},
		corrections: {},
		cause: {},
	}

	for (const arm of arms) {
		const spans = parseOf(arm, row.source_id)

		if (!spans) throw new Error(`${spec.id}: ${arm} has no parse for ${row.source_id}`)

		const expected = expectedFields()
		const gotFields = batteryFieldMap(spans.map((span) => [span[0], span[3]] as const))

		result.rightUncorrected[arm] = batteryFieldKey(gotFields) === result.expected
		result.corrections[arm] = correctBatteryFields(row, expected, gotFields, spans)

		const expectedKey = batteryFieldKey(expected)
		const got = batteryFieldKey(gotFields)

		result.got[arm] = got
		result.right[arm] = got === expectedKey
		result.cause[arm] = got === expectedKey ? null : classifyBatteryError(row.raw, expected, spans, gotFields)
	}

	return result
}

/**
 * Renders a battery run as markdown: decision-row totals, label-convention rows,
 * corrections, causes, each candidate against the baseline by cause, seed agreement,
 * examples by cause, and the failure groups with full addresses.
 */
export function formatBatteryReport(report: BatteryReport, writtenAt: string): string {
	const { arms, baseline, seeds } = report
	const names = arms.map((a) => a.name)
	const candidates = names.filter((n) => n !== baseline)
	const suites = Object.entries(report.suites)
	const allDecision = suites.flatMap(([, { rows }]) => rows.filter((r) => !r.labelConvention))

	const lines: string[] = [
		"# Comparison battery",
		"",
		`Baseline \`${baseline}\`; candidates ${candidates.map((c) => `\`${c}\``).join(", ")}. ` +
			`Arms: ${arms.map((a) => `\`${a.name}\` = \`${a.cache}\``).join("; ")}. Written ${writtenAt}.`,
		"",
		"A row is right when every field matches with street prefix, name and suffix joined. Rows marked label " +
			"convention follow a labeling choice of ours (see `battery/suites.ts`) and are kept out of the decision totals.",
		"",
		"## Right, decision rows only",
		"",
		`| Suite | Rows | ${names.join(" | ")} | Label-convention rows |`,
		`| --- | ---: | ${names.map(() => "---:").join(" | ")} | ---: |`,
	]

	for (const [suite, { rows }] of suites) {
		const decision = rows.filter((r) => !r.labelConvention)
		const rates = names.map((a) => formatPercent(decision.filter((r) => r.right[a]).length, decision.length))

		lines.push(
			`| ${suite} | ${decision.length.toLocaleString("en")} | ${rates.join(" | ")} | ` +
				`${(rows.length - decision.length).toLocaleString("en")} |`
		)
	}

	lines.push(
		`| **all suites** | ${allDecision.length.toLocaleString("en")} | ` +
			`${names.map((a) => formatPercent(allDecision.filter((r) => r.right[a]).length, allDecision.length)).join(" | ")} | |`,
		"",
		"## Label-convention rows by group",
		"",
		"| Group | Rows | Reason |",
		"| --- | ---: | --- |"
	)

	for (const [group, reason] of Object.entries(LABEL_CONVENTION_GROUPS)) {
		const n = suites.reduce((sum, [, { rows }]) => sum + rows.filter((r) => r.labelConvention === group).length, 0)

		lines.push(`| ${group} | ${n.toLocaleString("en")} | ${reason} |`)
	}

	lines.push(
		"",
		"## Corrections to the expected answer, decision rows only",
		"",
		"Rows each correction touched for an arm, and of those, rows it turned from wrong to right.",
		"",
		`| Correction | ${names.map((a) => `${a} touched | ${a} now right`).join(" | ")} |`,
		`| --- | ${names.map(() => "---: | ---:").join(" | ")} |`
	)

	for (const group of Object.keys(CORRECTION_GROUPS)) {
		const cells = names.map((a) => {
			const touched = allDecision.filter((r) => r.corrections[a]!.includes(group))

			return `${touched.length} | ${touched.filter((r) => r.right[a] && !r.rightUncorrected[a]).length}`
		})

		lines.push(`| ${group} | ${cells.join(" | ")} |`)
	}

	lines.push(
		"",
		...Object.entries(CORRECTION_GROUPS).map(([group, reason]) => `- \`${group}\`: ${reason}.`),
		"",
		"## Wrong rows by cause, decision rows only",
		"",
		`| Cause | ${names.join(" | ")} |`,
		`| --- | ${names.map(() => "---:").join(" | ")} |`
	)

	for (const cause of BATTERY_CAUSES) {
		const counts = names.map((a) => allDecision.filter((r) => r.cause[a] === cause).length.toLocaleString("en"))

		lines.push(`| ${cause} | ${counts.join(" | ")} |`)
	}

	lines.push(
		"",
		"## Each candidate against the baseline, by cause",
		"",
		"A fix is a row the baseline gets wrong and the candidate right, filed under the baseline's cause. " +
			"A break is the reverse, filed under the candidate's cause.",
		""
	)

	for (const candidate of candidates) {
		lines.push(`### ${candidate}`, "", "| Cause | Fixes | Breaks | Net |", "| --- | ---: | ---: | ---: |")

		for (const cause of BATTERY_CAUSES) {
			const fixes = allDecision.filter(
				(r) => !r.right[baseline] && r.right[candidate] && r.cause[baseline] === cause
			).length

			const breaks = allDecision.filter(
				(r) => r.right[baseline] && !r.right[candidate] && r.cause[candidate] === cause
			).length

			lines.push(`| ${cause} | ${fixes} | ${breaks} | ${fixes - breaks >= 0 ? "+" : ""}${fixes - breaks} |`)
		}

		lines.push("")
	}

	if (seeds.length >= 2) {
		lines.push(
			"## Seed agreement",
			"",
			`Rows where the seeds ${seeds.map((s) => `\`${s}\``).join(" and ")} disagree (one right, one wrong), ` +
				"decision rows only.",
			"",
			"| Suite | Rows | Seeds disagree | Share |",
			"| --- | ---: | ---: | ---: |"
		)

		const disagrees = (r: BatteryRowResult) => new Set(seeds.map((s) => r.right[s])).size > 1

		for (const [suite, { rows }] of suites) {
			const decision = rows.filter((r) => !r.labelConvention)
			const disagree = decision.filter(disagrees).length

			lines.push(`| ${suite} | ${decision.length} | ${disagree} | ${formatPercent(disagree, decision.length)} |`)
		}

		const disagreeAll = allDecision.filter(disagrees).length

		lines.push(
			`| **all suites** | ${allDecision.length} | ${disagreeAll} | ${formatPercent(disagreeAll, allDecision.length)} |`,
			""
		)
	}

	lines.push("## Examples by cause", "", "Up to four rows per cause where the baseline and a candidate differ.", "")

	for (const cause of BATTERY_CAUSES) {
		const examples = allDecision
			.filter(
				(r) => candidates.some((c) => r.right[c] !== r.right[baseline]) && names.some((a) => r.cause[a] === cause)
			)
			.slice(0, 4)

		if (!examples.length) continue

		lines.push(`### ${cause}`, "")

		for (const e of examples) {
			lines.push(`- \`${e.raw}\` (${e.country})`, `  - expected: ${e.expected}`)

			for (const a of names) {
				lines.push(`  - ${a}: ${e.right[a] ? "right" : `${e.got[a]} (${e.cause[a]})`}`)
			}
		}

		lines.push("")
	}

	return `${lines.join("\n")}\n${formatFailureGroups(groupBatteryFailures(report), names)}`
}
