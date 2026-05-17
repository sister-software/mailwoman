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

const CorpusList = () => {
	const adapters = defaultAdapterRegistry.list()

	if (adapters.length === 0) {
		return (
			<Box flexDirection="column">
				<Text dimColor>No adapters registered.</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column">
			{adapters.map((a) => (
				<Box key={a.id}>
					<Text bold>{a.id}</Text>
					<Text>{"  "}</Text>
					<Text dimColor>{a.defaultLicense}</Text>
					<Text>{"  "}</Text>
					<Text>{a.description}</Text>
				</Box>
			))}
		</Box>
	)
}

export default CorpusList
