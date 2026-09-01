/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deprecation-shim factory — the `mailwoman wof *` commands moved. Each sibling is one call naming its
 *   replacement; remove them, and this file with the last of them, after the one-minor-version courtesy window.
 */

import { Text } from "ink"
import type { FC } from "react"

import { useCommandTask } from "#cli-kit"

/**
 * One moved-command shim component printing the replacement and exiting 1. The `spec` stays a literal in each sibling
 * file — the option-collision test inspects specs statically and cannot see through a factory return.
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
