// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Deprecation shim — `mailwoman wof sync` moved. One-minor-version courtesy redirect. remove after.
 */

import type { CommandSpec } from "#cli-kit"

import { createWOFShim } from "./_shim.tsx"

/**
 * Kept literal (not factory-built) so the option-collision test can inspect it statically.
 */
export const spec = { name: "sync", description: "Show the replacement command" } as const satisfies CommandSpec

export default createWOFShim("sync", "mailwoman gazetteer inspect sync")
