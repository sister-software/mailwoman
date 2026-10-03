/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate address-systems` regenerates the trainer's address-system registry,
 *   `corpus-python/src/mailwoman_train/address_systems.json`, from codex's layouts.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, reportToStderr, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "address-systems",
	description: "Generate the trainer's address-system registry from codex layouts",
} as const satisfies CommandSpec

const DevGenerateAddressSystems = () => {
	const state = useCommandTask(async () => {
		const { generateAddressSystems } = await import("#tools/dev-tools/codex/address/systems")

		return generateAddressSystems(undefined, reportToStderr)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return (
		<Text color="green">
			✓ wrote {state.result.outPath} ({state.result.systems} systems, {state.result.members} members)
		</Text>
	)
}

export default DevGenerateAddressSystems
