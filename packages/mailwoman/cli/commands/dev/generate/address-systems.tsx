// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman dev generate address-systems` regenerates the trainer's address-system registry,
 *   `packages/trainer/data/address_systems.json`, from codex's layouts.
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
