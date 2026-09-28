/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rendering for the ablation map, where a cell nobody measured must never render as a zero and {@linkcode ABLATION_ABSENT} covers the three distinct absences.
 */

import { toLinesText } from "@mailwoman/core/fs/writers"
import { formatPercent } from "@mailwoman/core/stats"

import { ABLATION_ABSENT } from "#eval-harness/gauntlet/ablation/expectation"
import {
	ABLATABLE_COMPONENTS,
	type AblationCell,
	type AblationRowOutcome,
	aggregateAblationComponents,
} from "#eval-harness/gauntlet/ablation/types"

export { ABLATION_ABSENT } from "#eval-harness/gauntlet/ablation/expectation"

/**
 * Renders one cell as `broken/support`, with a missing or zero-support cell rendering
 * as {@linkcode ABLATION_ABSENT} rather than a zero.
 */
export function formatAblationCell(cell: AblationCell | undefined): string {
	if (!cell || cell.support === 0) return ABLATION_ABSENT

	return `${cell.brokenCount}/${cell.support}`
}

/**
 * Renders one cell under the expectation model as `trueFail/ladderGraded`, where a cell with real
 * support but a zero `ladderGradedCount` renders as {@linkcode ABLATION_ABSENT} rather than `0/0`.
 */
export function formatAblationLadderCell(cell: AblationCell | undefined): string {
	if (!cell || cell.support === 0 || cell.ladderGradedCount === 0) return ABLATION_ABSENT

	return `${cell.trueFailCount}/${cell.ladderGradedCount}`
}

function cellKey(component: string, locale: string): string {
	return `${component}|${locale}`
}

/**
 * Renders the map: a global per-component summary, the component × locale matrix over
 * locales with at least `minLocaleRows` rows, then the tail locales in long form.
 */
export function renderAblationMarkdown(
	cells: readonly AblationCell[],
	/**
	 * The per-row outcomes behind `cells`, needed because a global p90 must pool displacements rather than aggregate per-cell p90s. Pass `[]` to render the matrix alone.
	 */
	rows: readonly AblationRowOutcome[],
	meta: {
		boardID: string
		measuredAt: string
		caseCount: number
		variantCount: number
		skips: readonly { component: string; reason: string }[]
		pins: string
		minLocaleRows?: number
	}
): string {
	const minLocaleRows = meta.minLocaleRows ?? 3
	const byKey = new Map(cells.map((c) => [cellKey(c.component, c.locale), c]))
	const components = ABLATABLE_COMPONENTS.filter((tag) => cells.some((c) => c.component === tag))

	const localeSupport = new Map<string, number>()

	for (const c of cells) {
		localeSupport.set(c.locale, (localeSupport.get(c.locale) ?? 0) + c.support)
	}

	const locales = [...localeSupport.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
	const wide = locales.filter(([, n]) => n >= minLocaleRows).map(([l]) => l)
	const tail = locales.filter(([, n]) => n < minLocaleRows).map(([l]) => l)

	const lines: string[] = [
		`# Gauntlet ablation map — the required components`,
		"",
		`- board: \`${meta.boardID}\``,
		`- measured: ${meta.measuredAt}`,
		`- ${meta.caseCount} cases → ${meta.variantCount} deletion variants (+ ${meta.caseCount} anchors)`,
		`- ${meta.pins}`,
		`- \`${ABLATION_ABSENT}\` means NOT MEASURED (no row in this corpus carries that component in that locale). It is never a score of zero.`,
		"",
		`## Per component (all locales)`,
		"",
		`| component | support | broken | broken % | p50 km | p90 km | tier drop | unresolved | substituted |`,
		`| --- | --: | --: | --: | --: | --: | --: | --: | --: |`,
	]

	const aggregates = aggregateAblationComponents(cells, rows)

	for (const aggregate of aggregates) {
		const { displacementKmP50: p50, displacementKmP90: p90 } = aggregate

		lines.push(
			`| ${aggregate.component} | ${aggregate.support} | ${aggregate.brokenCount} | ${formatPercent(aggregate.brokenCount, aggregate.support)} | ` +
				`${p50 == null ? ABLATION_ABSENT : p50.toFixed(2)} | ${p90 == null ? ABLATION_ABSENT : p90.toFixed(2)} | ` +
				`${aggregate.tierDropCount} | ${aggregate.unresolvedCount} | ${aggregate.substitutedCount} |`
		)
	}

	lines.push(
		"",
		`## Per component — the EXPECTATION model (what the deletion is ALLOWED to cost)`,
		"",
		`Graded against the row's degradation ladder, not against its anchor. \`held\` + \`degraded\` + \`abstained\` are PASSES.`,
		"",
		`| component | ladder-graded | true fail | fail % | held | degraded | abstained | lost | overconfident | homonym | coarser | wrong | substituted | unconstrained | ungraded |`,
		`| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |`
	)

	for (const aggregate of aggregates) {
		const { grades, ladderGradedCount: denominator, trueFailCount: trueFail } = aggregate

		if (!denominator) {
			lines.push(`| ${aggregate.component} |${` ${ABLATION_ABSENT} |`.repeat(13)} ${grades.ungraded} |`)

			continue
		}

		lines.push(
			`| ${aggregate.component} | ${denominator} | ${trueFail} | ${formatPercent(trueFail, denominator)} | ${grades.held} | ` +
				`${grades.degraded} | ${grades.correctlyAbstained} | ${grades.lost} | ` +
				`${grades.overconfident} | ${grades.homonymTakeover} | ${grades.coarser} | ` +
				`${grades.wrong} | ${grades.substituted} | ${aggregate.unconstrainedCount} | ${grades.ungraded} |`
		)
	}

	lines.push(
		"",
		`## component × locale — true fail / ladder-graded`,
		"",
		`\`${ABLATION_ABSENT}\` here also covers a cell with real support the ladder could not grade (no gazetteer place for its anchor) — a zero denominator is never printed as a score.`,
		""
	)

	if (wide.length) {
		lines.push(`| component | ${wide.join(" | ")} |`)
		lines.push(`| --- | ${wide.map(() => "--:").join(" | ")} |`)

		for (const tag of components) {
			lines.push(`| ${tag} | ${wide.map((l) => formatAblationLadderCell(byKey.get(cellKey(tag, l)))).join(" | ")} |`)
		}
	}

	lines.push("")
	lines.push(`## component × locale — broken / support (the pre-2026-08-05 anchor grading, kept for the diff)`)
	lines.push("")

	// A zero-column matrix would render as a table with an empty header, which reads as
	// a rendering bug rather than as no locale clearing the threshold.
	if (!wide.length) {
		lines.push(`No locale carries ${minLocaleRows} or more measured rows — every locale is in the tail below.`)
	} else {
		lines.push(`| component | ${wide.join(" | ")} |`)
		lines.push(`| --- | ${wide.map(() => "--:").join(" | ")} |`)

		for (const tag of components) {
			lines.push(`| ${tag} | ${wide.map((l) => formatAblationCell(byKey.get(cellKey(tag, l)))).join(" | ")} |`)
		}
	}

	if (tail.length) {
		lines.push("")
		lines.push(`### Locales below ${minLocaleRows} rows (printed, not dropped)`)
		lines.push("")

		for (const locale of tail) {
			const own = cells.filter((c) => c.locale === locale)

			lines.push(`- **${locale}** — ${own.map((c) => `${c.component} ${c.brokenCount}/${c.support}`).join(", ")}`)
		}
	}

	if (meta.skips.length) {
		const byReason = new Map<string, number>()

		for (const s of meta.skips) {
			// Reasons carry the offending value inline, so bucket by the leading clause to count classes.
			const cls = s.reason.split(":")[0]!.split(" inside")[0]!

			byReason.set(cls, (byReason.get(cls) ?? 0) + 1)
		}

		lines.push("")
		lines.push(`### Asserted components NOT deleted (why a cell is thin)`)
		lines.push("")

		for (const [reason, n] of [...byReason].toSorted((a, b) => b[1] - a[1])) {
			lines.push(`- ${reason}: ${n}`)
		}
	}

	return toLinesText(lines)
}
