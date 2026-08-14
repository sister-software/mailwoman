/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus list` — print every adapter known to the default registry, one per line.
 *
 *   Used by humans and by scripts that want to fan out a build over adapters. Prints nothing (zero
 *   lines + exit 0) when no adapter has been registered yet; that's the expected state during early
 *   Phase 1 while adapters are still being authored.
 */

import { Box, Text } from "ink"
import { type CommandSpec, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = { name: "list", description: "List registered corpus adapters" } as const satisfies CommandSpec

/**
 * Per-line output is rendered as a single `Text` node so Ink does not column-wrap the adapter id when the host stdout
 * is non-TTY (CI, spawned tests). The list is meant to be grep-friendly, not pretty.
 */
const CorpusList = () => {
	const state = useCommandTask(async () => {
		const { defaultAdapterRegistry } = await import("@mailwoman/corpus")

		return defaultAdapterRegistry.list()
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status !== "done") return null

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
