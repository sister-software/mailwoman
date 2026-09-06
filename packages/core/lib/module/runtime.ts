// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Turn on Node's on-disk compile cache for this process — a CLI entry calls it first thing, so every later import is
 * served from the cache the previous run wrote.
 */
export { enableCompileCache } from "node:module"
