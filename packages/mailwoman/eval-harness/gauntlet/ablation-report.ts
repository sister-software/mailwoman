/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   RENDERING for the ablation map — the markdown artifact and the two cell formatters, split out of `ablation.ts` so
 *   the runner stays a runner.
 *
 *   One rule governs every line here and it is the only one a reader of the finished table can be misled by: a cell
 *   nobody measured must never render as a zero. {@linkcode ABLATION_ABSENT} covers three distinct absences — no cell
 *   for that (component, locale) pair, a cell with zero support, and (since the expectation model) a cell with real
 *   support that no ladder could grade. A consumer that needs to tell them apart still can, in the JSON.
 */

import { formatPercent, percentile } from "@mailwoman/core/utils"

import { ABLATION_ABSENT } from "./ablation-expectation.ts"
import { ABLATABLE_COMPONENTS, type AblationCell, type AblationRowOutcome } from "./ablation-types.ts"

export { ABLATION_ABSENT } from "./ablation-expectation.ts"

/**
 * Render one cell for the matrix: `broken/support` plus the p90 displacement. A missing cell or a zero-support one
 * renders as {@linkcode ABLATION_ABSENT} — never `0`, never `0.0%`. This is the meaning-of-zero rule at the only place
 * a human reads the map and the reason the renderer takes `AblationCell | undefined` rather than a number.
 */
export function formatAblationCell(cell: AblationCell | undefined): string {
	if (!cell || cell.support === 0) return ABLATION_ABSENT

	return `${cell.brokenCount}/${cell.support}`
}

/**
 * Render one cell under the EXPECTATION model: `trueFail/ladderGraded`. Absence has one more source here than in
 * {@linkcode formatAblationCell} — a cell can have real support and still have nothing the ladder could grade (no
 * gazetteer, or an anchor that resolved no place id). That is `ladderGradedCount: 0`, and it renders as
 * {@linkcode ABLATION_ABSENT} rather than `0/0`, which would read as "nothing failed here".
 */
export function formatAblationLadderCell(cell: AblationCell | undefined): string {
	if (!cell || cell.support === 0 || cell.ladderGradedCount === 0) return ABLATION_ABSENT

	return `${cell.trueFailCount}/${cell.ladderGradedCount}`
}

function cellKey(component: string, locale: string): string {
	return `${component}|${locale}`
}

/**
 * Render the map: a global per-component summary, then the component × locale matrix over the locales carrying at least
 * `minLocaleRows` rows, then the tail locales in long form. The matrix is bounded on purpose — 29 countries × 9
 * components is a table nobody reads, and folding the tail is only acceptable because it is PRINTED, not dropped.
 */
export function renderAblationMarkdown(
	cells: readonly AblationCell[],
	/**
	 * The per-row outcomes behind `cells`. Needed because percentiles do NOT aggregate: a global p90 has to be taken over
	 * the pooled displacements, not over the per-cell p90s. Pass `[]` to render the matrix alone.
	 */
	rows: readonly AblationRowOutcome[],
	meta: {
		boardID: string
		measuredAt: string
		caseCount: number
		variantCount: number
		skips: readonly { component: string; reason: string }[]
		levers: string
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
		`- ${meta.levers}`,
		`- \`${ABLATION_ABSENT}\` means NOT MEASURED (no row in this corpus carries that component in that locale). It is never a score of zero.`,
		"",
		`## Per component (all locales)`,
		"",
		`| component | support | broken | broken % | p50 km | p90 km | tier drop | unresolved | substituted |`,
		`| --- | --: | --: | --: | --: | --: | --: | --: | --: |`,
	]

	for (const tag of components) {
		const own = cells.filter((c) => c.component === tag)
		const support = own.reduce((n, c) => n + c.support, 0)
		const broken = own.reduce((n, c) => n + c.brokenCount, 0)
		const tierDrop = own.reduce((n, c) => n + c.tierDropCount, 0)
		const unresolved = own.reduce((n, c) => n + c.unresolvedCount, 0)
		const substituted = own.reduce((n, c) => n + c.substitutedCount, 0)
		const pooled = rows.filter((r) => r.component === tag && r.displacementKm != null).map((r) => r.displacementKm!)
		const p50 = percentile(pooled, 50)
		const p90 = percentile(pooled, 90)

		lines.push(
			`| ${tag} | ${support} | ${broken} | ${formatPercent(broken, support)} | ` +
				`${p50 == null ? ABLATION_ABSENT : p50.toFixed(2)} | ${p90 == null ? ABLATION_ABSENT : p90.toFixed(2)} | ` +
				`${tierDrop} | ${unresolved} | ${substituted} |`
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

	for (const tag of components) {
		const own = cells.filter((c) => c.component === tag)
		const denominator = own.reduce((n, c) => n + c.ladderGradedCount, 0)
		const sum = (pick: (c: AblationCell) => number): number => own.reduce((n, c) => n + pick(c), 0)
		const ungraded = sum((c) => c.grades.ungraded)

		if (!denominator) {
			lines.push(`| ${tag} |${` ${ABLATION_ABSENT} |`.repeat(13)} ${ungraded} |`)

			continue
		}

		const trueFail = sum((c) => c.trueFailCount)

		lines.push(
			`| ${tag} | ${denominator} | ${trueFail} | ${formatPercent(trueFail, denominator)} | ${sum((c) => c.grades.held)} | ` +
				`${sum((c) => c.grades.degraded)} | ${sum((c) => c.grades.correctlyAbstained)} | ${sum((c) => c.grades.lost)} | ` +
				`${sum((c) => c.grades.overconfident)} | ${sum((c) => c.grades.homonymTakeover)} | ${sum((c) => c.grades.coarser)} | ` +
				`${sum((c) => c.grades.wrong)} | ${sum((c) => c.grades.substituted)} | ${sum((c) => c.unconstrainedCount)} | ${ungraded} |`
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

	// A zero-column matrix would render as a table with an empty header, which reads as a rendering bug rather
	// than as "no locale cleared the threshold". Say the latter.
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
			// Reasons carry the offending value inline; bucket by the leading clause so the report counts CLASSES.
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

	return lines.join("\n") + "\n"
}
