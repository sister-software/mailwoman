/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { booleanValue, type CommandSpec, runNativeCommand } from "#cli-native/spec"

/**
 * Native installation diagnostic contract.
 */
export const spec = {
	name: "doctor",
	description:
		"Check whether this machine can run mailwoman, and what each gap costs you. Runtime first (node, ONNX), then the model weights, then the optional data layers geocoding needs — a missing layer is reported, never fatal, and every failing line carries the one command that closes it. Then the license posture: the branch of mailwoman's license that applies to this installation, and the obligations each attached layer's recorded license carries (attribution, share-alike, source offer).",
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
	return await runNativeCommand(spec, args, async (parsed) => {
		const { runDoctor, describeEnvironment, renderDoctorReport } = await import("#doctor")

		const report = await runDoctor()
		const environment = booleanValue(parsed.values, "verbose") ? await describeEnvironment() : undefined

		process.stdout.write(
			booleanValue(parsed.values, "json")
				? `${JSON.stringify(environment ? { ...report, environment } : report, null, 2)}\n`
				: `${renderDoctorReport(report, environment)}\n`
		)

		return report.exitCode
	})
}
