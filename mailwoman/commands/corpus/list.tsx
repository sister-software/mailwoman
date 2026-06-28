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

import { defaultAdapterRegistry } from "@mailwoman/corpus"
import { Box, Text } from "ink"

/**
 * Per-line output is rendered as a single `Text` node so Ink does not column-wrap the adapter id when the host stdout
 * is non-TTY (CI, spawned tests). The list is meant to be grep-friendly, not pretty.
 */
const CorpusList = () => {
	const adapters = defaultAdapterRegistry.list()

	if (adapters.length === 0) {
		return <Text dimColor>No adapters registered.</Text>
	}

	return (
		<Box flexDirection="column">
			{adapters.map((a) => (
				<Text key={a.id}>{`${a.id}\t${a.defaultLicense}\t${a.description}`}</Text>
			))}
		</Box>
	)
}

export default CorpusList
