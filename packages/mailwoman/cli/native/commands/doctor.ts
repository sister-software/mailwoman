// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { prettyJSON } from "@mailwoman/core/json"

import { booleanValue, type CommandSpec, runNativeCommand } from "#cli/native/spec"

/**
 * Native installation diagnostic interface.
 */
export const spec = {
	name: "doctor",
	description:
		"Check whether this machine can run mailwoman, and what each missing component costs you. The checks cover the runtime first (node, ONNX), then the model weights, then the optional data layers that geocoding needs. A missing data layer is reported without failing the command, and every failing line prints the command that fixes it. The report ends with the license that applies: the branch of mailwoman's license for this installation, and the obligations that each attached layer's recorded license imposes (attribution, share-alike, source offer).",
	options: {
		json: {
			type: "boolean",
			default: false,
			description:
				"Emit the report as JSON instead of a checklist: { checks: [{ id, label, status, detail, consequence?, fix?, core }], exitCode } — a superset of { id, status, detail, fix? } (label + core + consequence aid machine consumers). With --verbose, an `environment` array of { key, value, source } is added.",
		},
		verbose: {
			type: "boolean",
			default: false,
			description:
				"Also print every path and environment variable the checks resolved (data root, candidate.db, WOF databases, weights) so a surprising verdict can be traced to the setting that caused it. No -v short form: the root program owns -v for --version.",
		},
	},
} as const satisfies CommandSpec

/**
 * Run `mw doctor` without loading its former React/Ink adapter.
 */
export async function run(args: readonly string[]): Promise<number> {
	return runNativeCommand(spec, args, async (parsed) => {
		const { runDoctor, describeEnvironment, renderDoctorReport } = await import("#doctor")

		const report = await runDoctor()
		const environment = booleanValue(parsed.values, "verbose") ? await describeEnvironment() : null

		process.stdout.write(
			booleanValue(parsed.values, "json")
				? prettyJSON(environment ? { ...report, environment } : report)
				: `${renderDoctorReport(report, environment ?? undefined)}\n`
		)

		return report.exitCode
	})
}
