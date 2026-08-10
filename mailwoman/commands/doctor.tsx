/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman doctor [--json] [--verbose]` — the out-of-box diagnostic. A consumer who just ran `npm
 *   i mailwoman` runs this and learns exactly what works, what's missing, what each gap COSTS them,
 *   and the ONE command that fixes it. Seven checks in reading order: the Node runtime, the ONNX
 *   binding, the model weights, the data root, the admin gazetteer, the POI layer, and the fr-fr
 *   locale overlay (informational).
 *
 *   Exit-code contract (meaning-of-zero, per `checks.ts`):
 *
 *   - 0 when every CORE check (runtime + weights) is `ok` — parse is ready, even with no data layers.
 *   - 1 when any core check is not `ok`.
 *
 *   Data layers (data root, gazetteer, POI) are OPTIONAL: a gap is reported as missing/degraded with a
 *   consequence line and a fix hint, never a hard failure — parse runs without them. All verdict logic
 *   is pure and unit-tested in `doctor/checks.ts`; the IO seams live in `doctor/runner.ts`.
 *
 *   THE CHECKLIST IS RAW STDOUT, NOT AN INK FRAME (#1577). Ink clears the terminal — scrollback
 *   included, via `\x1b[3J` — whenever a frame is at least as tall as the viewport. Measured
 *   2026-08-10: `doctor --verbose` on a failing install renders 114 lines, and on a 24-row terminal
 *   that emitted one full clear per run; the plain report is one bad install away from the same fate.
 *   Ink also hard-wraps at the terminal width, which broke long data-root paths mid-string. Colour
 *   comes from chalk instead, which no-ops when stdout is not a TTY.
 *
 *   NO `-v` SHORT FLAG. Pastel registers `program.version(version, "-v, --version")` on the ROOT
 *   program, and commander (without `enablePositionalOptions`) scans the whole argv for the root's own
 *   options before a subcommand ever sees them — so `mailwoman doctor -v` prints the version number
 *   and exits, even for a subcommand that declares `-v` itself (verified 2026-08-10 against commander
 *   14 with pastel's exact registration order). This is the short-flag face of #1491. `--verbose` only.
 */

import chalk from "chalk"
import { Text } from "ink"
import { type CommandComponent, useCommandTask, writeRawStdout } from "mailwoman/cli-kit"
import zod from "zod"

import { CheckStatus, type DoctorCheck, type DoctorReport } from "../doctor/checks.ts"
import { describeEnvironment, runDoctor, type EnvironmentEntry } from "../doctor/runner.ts"

/**
 * Shown at the top of `mailwoman doctor --help` — the explainer #1577 asked for. Commander reuses it in the root
 * command listing, so it is held to two sentences.
 */
export const description =
	"Check whether this machine can run mailwoman, and what each gap costs you. Runtime first (node, ONNX), then " +
	"the model weights, then the optional data layers geocoding needs — a missing layer is reported, never fatal, " +
	"and every failing line carries the one command that closes it."

const OptionsSchema = zod.object({
	json: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Emit the report as JSON instead of a checklist: { checks: [{ id, label, status, detail, consequence?, fix?, core }], exitCode } " +
				"— a superset of { id, status, detail, fix? } (label + core + consequence aid machine consumers). With --verbose, " +
				"an `environment` array of { key, value, source } is added."
		),
	verbose: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Also print every path and environment variable the checks resolved (data root, candidate.db, WOF shards, " +
				"weights) so a surprising verdict can be traced to the setting that caused it. No -v short form: the root " +
				"program owns -v for --version."
		),
})

export { OptionsSchema as options }

/**
 * The status glyph + colouring function for a check outcome.
 */
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

/**
 * One check's lines: the glyph + label + detail, plus the indented consequence and `fix:` lines and an `(optional)` tag
 * for non-core gaps.
 */
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

/**
 * The `--verbose` block: every resolved path/variable, key-aligned. `(unset)` is printed rather than skipped — an
 * absent row would leave the reader unable to tell "unset" from "this doctor doesn't look at that".
 */
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
 * The whole rendered report: header, optional environment dump, the checklist, and the PASS/FAIL summary.
 */
function renderReport(report: DoctorReport, environment?: readonly EnvironmentEntry[]): string {
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

/**
 * The report plus, under `--verbose`, the resolved settings behind it.
 */
interface DoctorOutcome {
	report: DoctorReport
	rendered: string
}

const DoctorCommand: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	// `--json` writes the report straight to stdout via `console.log` (mirroring `mailwoman openapi`) and
	// prints no checklist. The checklist form goes out through `writeRawStdout` for the reasons in the
	// module docstring — either way Ink is handed nothing to draw.
	const state = useCommandTask<DoctorOutcome>(
		async () => {
			const report = await runDoctor()
			const environment = options.verbose ? describeEnvironment() : undefined

			if (options.json) {
				console.log(JSON.stringify(environment ? { ...report, environment } : report, null, 2))
			}

			return { report, rendered: renderReport(report, environment) }
		},
		(outcome) => outcome.report.exitCode
	)

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") return null

	// JSON payload already emitted in the task.
	if (options.json) return null

	return writeRawStdout(state.result.rendered)
}

export default DoctorCommand
