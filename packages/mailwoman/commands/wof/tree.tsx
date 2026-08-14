/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deprecation shim — `mailwoman wof tree` moved. One-minor-version courtesy redirect; remove after.
 */

import { Text } from "ink"
import { type CommandSpec, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = { name: "tree", description: "Show the replacement command" } as const satisfies CommandSpec

const WofShim = () => {
	useCommandTask(
		async () => {},
		() => 1
	)

	return <Text color="yellow">{"`mailwoman wof tree` moved: use `mailwoman gazetteer inspect tree`"}</Text>
}

export default WofShim
