/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman doctor [--json]` — the out-of-box diagnostic. A consumer who just ran `npm i mailwoman`
 *   runs this and learns exactly what works, what's missing, and the ONE command that fixes each gap.
 *   Six checks: model weights, the fr-fr locale overlay (informational), the data root, the admin
 *   gazetteer, the POI layer, and the Node + ONNX runtime.
 *
 *   Exit-code contract (meaning-of-zero, per `checks.ts`):
 *
 *   - 0 when every CORE check (weights + runtime) is `ok` — parse is ready, even with no data layers.
 *   - 1 when any core check is not `ok`.
 *
 *   Data layers (data root, gazetteer, POI) are OPTIONAL: a gap is reported as missing/degraded with a
 *   fix hint, never a hard failure — parse runs without them. All verdict logic is pure and unit-tested
 *   in `doctor/checks.ts`; the IO seams live in `doctor/runner.ts`.
 */

import { Box, Text } from "ink"
import type * as React from "react"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../cli-kit/index.ts"
import { CheckStatus, type DoctorCheck, type DoctorReport } from "../doctor/checks.ts"
import { runDoctor } from "../doctor/runner.ts"

const OptionsSchema = zod.object({
	json: zod
		.boolean()
		.optional()
		.default(false)
		.describe("Emit the report as JSON ({ checks: [{ id, status, detail, fix? }], exitCode }) instead of a checklist."),
})

export { OptionsSchema as options }

/** The status glyph + ink color for a check outcome. */
function statusGlyph(status: CheckStatus): { glyph: string; color: string } {
	switch (status) {
		case CheckStatus.OK:
			return { glyph: "✓", color: "green" }
		case CheckStatus.Degraded:
			return { glyph: "⚠", color: "yellow" }
		case CheckStatus.Missing:
			return { glyph: "✗", color: "red" }
	}
}

/** One check row: the glyph + label + detail, plus an indented `fix:` line and an `(optional)` tag for non-core gaps. */
function CheckRow({ check }: { check: DoctorCheck }): React.ReactElement {
	const { glyph, color } = statusGlyph(check.status)
	const optional = !check.core && check.status !== CheckStatus.OK ? " (optional)" : ""

	return (
		<Box flexDirection="column">
			<Text color={color}>
				{glyph} {check.label}: {check.detail}
				{optional}
			</Text>
			{check.fix ? <Text color="gray">{`    fix: ${check.fix}`}</Text> : null}
		</Box>
	)
}

/** The rendered checklist + PASS/FAIL summary. */
function Report({ report }: { report: DoctorReport }): React.ReactElement {
	const pass = report.exitCode === 0

	return (
		<Box flexDirection="column">
			<Text bold>mailwoman doctor</Text>
			<Text> </Text>
			{report.checks.map((check) => (
				<CheckRow key={check.id} check={check} />
			))}
			<Text> </Text>
			<Text color={pass ? "green" : "red"} bold>
				{pass ? "PASS — core checks ok (weights + runtime); parse is ready" : "FAIL — a core check is not ok"}
			</Text>
		</Box>
	)
}

const DoctorCommand: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	// `--json` writes the report straight to stdout via `console.log` (mirroring `mailwoman openapi`) and
	// renders NOTHING through Ink — Ink's `<Text>` hard-wraps to the terminal width, which would inject
	// newlines mid-string and corrupt the JSON when piped. The checklist form renders through Ink normally.
	const state = useCommandTask<DoctorReport>(
		async () => {
			const report = await runDoctor()

			if (options.json) {
				console.log(JSON.stringify(report, null, 2))
			}

			return report
		},
		(report) => report.exitCode
	)

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	// JSON payload already emitted in the task; give Ink nothing to draw (transient frames would pollute stdout).
	if (options.json) return null

	if (state.status !== "done") {
		return <Text color="gray">running diagnostics…</Text>
	}

	return <Report report={state.result} />
}

export default DoctorCommand
