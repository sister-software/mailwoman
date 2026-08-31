/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev download libpostal-resources` — refresh the checked-in libpostal dictionaries
 *   under `core/data/libpostal/dictionaries/` (shallow clone + code-point sort).
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "libpostal-resources",
	description: "Download and install the libpostal dictionaries.",
	options: {
		force: {
			type: "boolean",
			default: false,
			description: "Delete an existing dictionaries directory instead of erroring out",
		},
	},
} as const satisfies CommandSpec

interface Options {
	force: boolean
}

const DevDownloadLibpostalResources: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { downloadLibpostalResources } = await import("@mailwoman/core/tools")

		return downloadLibpostalResources(options, (line) => console.error(line))
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") return <Text color="green">dictionaries installed</Text>

	return null
}

export default DevDownloadLibpostalResources
