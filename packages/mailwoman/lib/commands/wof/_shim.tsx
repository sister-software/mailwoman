/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deprecation-shim factory for moved `mailwoman wof *` commands. Each sibling calls its replacement.
 *   Remove each shim after the one-minor-version courtesy window. Remove this file with the last shim.
 */

import { Text } from "ink"
import type { FC } from "react"

import { useCommandTask } from "#cli-kit"

/**
 * One moved-command shim component printing the replacement and exiting 1.
 *
 * The `spec` stays a literal in each sibling file.
 * The option-collision test inspects specs statically and cannot see through a factory return.
 */
export function createWOFShim(name: string, replacement: string): FC {
	const Shim: FC = () => {
		useCommandTask(
			async () => {},
			() => 1
		)

		return <Text color="yellow">{`\`mailwoman wof ${name}\` moved: use \`${replacement}\``}</Text>
	}

	return Shim
}
