// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Deprecation shim — `mailwoman wof sync` moved. One-minor-version courtesy redirect; remove after.
 */

import { Text } from "ink"

import { type CommandSpec, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = { name: "sync", description: "Show the replacement command" } as const satisfies CommandSpec

const WofShim = () => {
	useCommandTask(
		async () => {},
		() => 1
	)

	return <Text color="yellow">{"`mailwoman wof sync` moved: use `mailwoman gazetteer inspect sync`"}</Text>
}

export default WofShim
