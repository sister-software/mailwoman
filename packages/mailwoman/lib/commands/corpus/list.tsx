/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus list` — print every adapter known to the default registry, one per line, for humans
 *   and for scripts that fan a build out over adapters; it prints zero lines and exits 0 when no adapter has
 *   been registered.
 */

import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = { name: "list", description: "List registered corpus adapters" } as const satisfies CommandSpec

/**
 * Per-line output is one `Text` node so Ink does not column-wrap the adapter id on a
 * non-TTY stdout (CI, spawned tests), keeping the list grep-friendly rather than pretty.
 */
const CorpusList = () => {
	const state = useCommandTask(async () => {
		const { defaultAdapterRegistry } = await import("@mailwoman/corpus")

		return defaultAdapterRegistry.list()
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (!state.result.length) {
		return <Text dimColor>No adapters registered.</Text>
	}

	return (
		<Box flexDirection="column">
			{state.result.map((a) => (
				<Text key={a.id}>{`${a.id}\t${a.defaultLicense}\t${a.description}`}</Text>
			))}
		</Box>
	)
}

export default CorpusList
