// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Deprecation shim — `mailwoman wof mermaid` moved. One-minor-version courtesy redirect. remove after.
 */

import type { CommandSpec } from "#cli-kit"

import { createWOFShim } from "./_shim.tsx"

/**
 * Kept literal (not factory-built) so the option-collision test can inspect it statically.
 */
export const spec = { name: "mermaid", description: "Show the replacement command" } as const satisfies CommandSpec

export default createWOFShim("mermaid", "mailwoman gazetteer inspect mermaid")
