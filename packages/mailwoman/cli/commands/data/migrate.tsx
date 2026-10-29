/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data migrate --dry-run`: list the files today's readers select, classify each, and print the plan
 *   that would register them in place, with its rollback. This release plans only. Without `--dry-run` the
 *   command refuses and leaves the data root as it was.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import { planMigration } from "#data/migrate"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "migrate",
	description: "Plan the registration of existing data files in the active selection (dry run only)",
	options: {
		"dry-run": { type: "boolean", default: false, description: "Print the plan. Required in this release" },
		"data-root": { type: "string", description: "Override the data root" },
		json: { type: "boolean", default: false, description: "Emit the plan as JSON" },
	},
} as const satisfies CommandSpec

const DataMigrate: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			if (!options.dryRun) {
				throw new CommandError(
					"mailwoman data migrate executes no change in this release; run it with --dry-run to print the plan"
				)
			}

			const plan = await planMigration(options.dataRoot ?? dataRootPath())

			if (options.json) {
				writeRawStdout(plan)

				return { ok: true }
			}

			const lines = [`data root ${plan.dataRoot}, selection generation ${plan.basedOnGeneration ?? "none"}`, ""]

			for (const artifact of plan.artifacts) {
				const notes = [
					artifact.linkTarget ? `symlink to ${artifact.linkTarget}` : null,
					artifact.hardLinks > 1 ? `${artifact.hardLinks} hard links` : null,
					artifact.external ? "outside the data root" : null,
				].filter((note): note is string => note != null)

				lines.push(
					`  ${artifact.classification.padEnd(18)} ${ByteFormatter.formatSI(artifact.bytes).padStart(9)}  ${artifact.path}`,
					`  ${" ".repeat(18)} ${" ".repeat(9)}  ↳ ${artifact.reader}${artifact.role ? ` as ${artifact.role}` : ""}: ${artifact.reason}${notes.length ? `; ${notes.join(", ")}` : ""}`
				)
			}

			lines.push(
				"",
				`copies ${ByteFormatter.formatSI(plan.bytesToCopy)}; hashes ${ByteFormatter.formatSI(plan.bytesToHash)}`,
				...plan.steps.map((step, index) => `  ${index + 1}. ${step}`),
				`rollback: ${plan.rollback}`
			)

			writeRawStdout(lines.join("\n"))

			return { ok: true }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done")
		return <CommandTaskResult state={state} running={<Text color="gray">discovering…</Text>} />

	return null
}

export default DataMigrate
