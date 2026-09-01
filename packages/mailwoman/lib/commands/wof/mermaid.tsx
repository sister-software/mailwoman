/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Deprecation shim — `mailwoman wof mermaid` moved. One-minor-version courtesy redirect; remove after.
 */

import type { CommandSpec } from "#cli-kit"

import { createWOFShim } from "./_shim.tsx"

/**
 * Kept literal (not factory-built) so the option-collision test can inspect it statically.
 */
export const spec = { name: "mermaid", description: "Show the replacement command" } as const satisfies CommandSpec

export default createWOFShim("mermaid", "mailwoman gazetteer inspect mermaid")
