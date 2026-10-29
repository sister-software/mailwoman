/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data prune`: list, then delete, installed artifacts no retained generation and no live session
 *   references. `--dry-run` prints the plan and keeps every file. The retention policy is in
 *   `lib/data/retention.ts`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import { DEFAULT_RETAINED_GENERATIONS, executePrune, planPrune } from "#data/retention"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "prune",
	description: "Delete installed artifacts that no retained generation or running session references",
	options: {
		"dry-run": {
			type: "boolean",
			default: false,
			description: "List the artifacts a prune would delete and delete none",
		},
		retain: {
			type: "string",
			description: `Generations to keep, counting the active one. Default ${DEFAULT_RETAINED_GENERATIONS}`,
		},
		"data-root": { type: "string", description: "Override the data root" },
		json: { type: "boolean", default: false, description: "Emit the plan or the result as JSON" },
	},
} as const satisfies CommandSpec

const DataPrune: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const dataRoot = options.dataRoot ?? dataRootPath()
			const plan = await planPrune(dataRoot, options.retain ? { retain: Number(options.retain) } : {})

			if (options.dryRun) {
				if (options.json) {
					writeRawStdout(plan)
				} else {
					writeRawStdout(
						[
							`generation ${plan.generation ?? "none"}; keeping generations ${plan.retainedGenerations.join(", ") || "none"}` +
								` and ${plan.leases.length} running session lease(s)`,
							...plan.candidates.map(
								(candidate) =>
									`  would delete ${ByteFormatter.formatSI(candidate.bytes).padStart(9)}  ${candidate.directory}`
							),
							`${plan.candidates.length} artifact(s), ${ByteFormatter.formatSI(plan.reclaimableBytes)} reclaimable; run without --dry-run to delete them`,
						].join("\n")
					)
				}

				return { ok: true }
			}

			const result = await executePrune(plan)

			writeRawStdout(
				options.json
					? result
					: `deleted ${result.deleted.length} artifact(s), ${ByteFormatter.formatSI(result.reclaimedBytes)} reclaimed`
			)

			return { ok: true }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} running={<Text color="gray">planning…</Text>} />

	return null
}

export default DataPrune
