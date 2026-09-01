/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deprecation shim — `mailwoman wof tree` moved. One-minor-version courtesy redirect; remove after.
 */

import type { CommandSpec } from "#cli-kit"

import { createWOFShim } from "./_shim.tsx"

/**
 * Kept literal (not factory-built) so the option-collision test can inspect it statically.
 */
export const spec = { name: "tree", description: "Show the replacement command" } as const satisfies CommandSpec

export default createWOFShim("tree", "mailwoman gazetteer inspect tree")
