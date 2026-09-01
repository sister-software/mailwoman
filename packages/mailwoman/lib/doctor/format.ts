/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import chalk from "chalk"

import { CheckStatus, type DoctorCheck, type DoctorReport } from "#doctor/checks"
import type { EnvironmentEntry } from "#doctor/runner"

function statusStyle(status: CheckStatus): { glyph: string; paint: (text: string) => string } {
	switch (status) {
		case CheckStatus.OK:
			return { glyph: "✓", paint: chalk.green }
		case CheckStatus.Degraded:
			return { glyph: "⚠", paint: chalk.yellow }
		case CheckStatus.Missing:
			return { glyph: "✗", paint: chalk.red }
	}
}

function checkLines(check: DoctorCheck): string[] {
	const { glyph, paint } = statusStyle(check.status)
	const optional = !check.core && check.status !== CheckStatus.OK ? " (optional)" : ""
	const lines = [paint(`${glyph} ${check.label}: ${check.detail}${optional}`)]

	if (check.consequence) {
		lines.push(chalk.gray(`    why it matters: ${check.consequence}`))
	}

	if (check.fix) {
		lines.push(chalk.gray(`    fix: ${check.fix}`))
	}

	return lines
}

function environmentLines(entries: readonly EnvironmentEntry[]): string[] {
	const width = Math.max(...entries.map((entry) => entry.key.length))

	return [
		chalk.bold("resolved environment"),
		...entries.map((entry) =>
			chalk.gray(
				`  ${entry.key.padEnd(width)}  ${entry.value ?? "(unset)"}${entry.source ? `   [${entry.source}]` : ""}`
			)
		),
		"",
	]
}

/**
 * Render a doctor report for a terminal without involving Ink.
 */
export function renderDoctorReport(report: DoctorReport, environment?: readonly EnvironmentEntry[]): string {
	const pass = report.exitCode === 0

	return [
		chalk.bold("mailwoman doctor"),
		"",
		...(environment ? environmentLines(environment) : []),
		...report.checks.flatMap((check) => checkLines(check)),
		"",
		pass
			? chalk.green.bold("PASS — core checks ok (runtime + weights); parse is ready")
			: chalk.red.bold("FAIL — a core check is not ok"),
	].join("\n")
}
