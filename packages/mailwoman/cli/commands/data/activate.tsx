/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data activate <installation-id>` selects an installed installation's artifacts in one new
 *   generation of `active.json`. `--rollback` restores the generation the active one replaced. Both validate
 *   every selected file first and leave the previous generation in force when validation fails.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { LayerInstallationID } from "@mailwoman/core/layers"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import { activateInstallation, rollbackActiveSelection } from "#data/catalog"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "activate",
	description: "Select an installed installation, or restore the previous selection with --rollback",
	positionals: [
		{ name: "installation", description: "An installation identity, inst-<16 hex>, from `data status --json`" },
	],
	options: {
		rollback: { type: "boolean", default: false, description: "Restore the generation the active one replaced" },
		"data-root": { type: "string", description: "Override the data root" },
	},
} as const satisfies CommandSpec

const DataActivate: CommandComponent<typeof spec> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			const dataRoot = options.dataRoot ?? dataRootPath()
			const [installation] = args

			if (options.rollback === Boolean(installation)) {
				throw new CommandError("mailwoman data activate takes an installation identity or --rollback, and not both")
			}

			const selection = options.rollback
				? await rollbackActiveSelection(dataRoot)
				: await activateInstallation(dataRoot, installation as LayerInstallationID)

			writeRawStdout(
				`generation ${selection.generation} is active, replacing generation ${selection.previousGeneration ?? "none"}`
			)

			return { ok: true }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done")
		return <CommandTaskResult state={state} running={<Text color="gray">activating…</Text>} />

	return null
}

export default DataActivate
