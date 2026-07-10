/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deprecation shim — `mailwoman wof mermaid` moved. One-minor-version courtesy redirect; remove after.
 */

import { Text } from "ink"

import { useCommandTask } from "../../cli-kit/index.ts"

const WofShim = () => {
	useCommandTask(
		async () => {},
		() => 1
	)

	return <Text color="yellow">{"`mailwoman wof mermaid` moved: use `mailwoman gazetteer inspect mermaid`"}</Text>
}

export default WofShim
