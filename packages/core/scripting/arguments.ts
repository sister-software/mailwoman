// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Dependency-free process argument accessors. Kept separate from script cleanup/logging so latency-sensitive CLI
 * dispatchers can read argv without loading the ResourceError, ConsoleLogger, and async-init graphs.
 */

/**
 * The one blessed accessor for user CLI arguments.
 */
export function cliArguments(): string[] {
	// oxlint-disable-next-line sister-software/no-process-globals
	return process.argv.slice(2)
}

/**
 * The path of the executing script (`argv[1]`).
 */
export function scriptEntryPath(): string {
	// oxlint-disable-next-line sister-software/no-process-globals
	return process.argv[1]!
}
