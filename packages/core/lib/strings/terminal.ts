/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Text a terminal program wrote, as plain text.
 */

import { stripVTControlCharacters } from "node:util"

/**
 * `text` with its ANSI escape sequences removed, such as the colour codes a
 * test runner writes around `FAIL`.
 */
export function stripTerminalControls(text: string): string {
	return stripVTControlCharacters(text)
}
