/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Dependency-free process argument accessors. Kept separate from script cleanup/logging so latency-sensitive CLI
 * dispatchers can read argv without loading the ResourceError, ConsoleLogger, and async-init graphs.
 */

export type UnsafeCLIArgument = string & { __unsafeCLIArgumentBrand: never }

export type UnsafeCLIArguments = ReadonlyArray<UnsafeCLIArgument>

/**
 * The one blessed accessor for user CLI arguments.
 */
export function cliArguments(): UnsafeCLIArguments {
	// oxlint-disable-next-line sister-software/no-process-globals -- this function is the blessed argv accessor
	return process.argv.slice(2) as unknown as UnsafeCLIArguments
}

/**
 * Forward the CLI arguments to a child process.
 *
 * Do not use this function unless its arguments are being passed to a child process.
 */
export function passThroughCLIArguments(): readonly unknown[] {
	// oxlint-disable-next-line sister-software/no-process-globals -- Forwarding arguments to a child process.
	return process.argv.slice(2)
}

/**
 * The path of the executing script (`argv[1]`).
 */
export function scriptEntryPath(): string {
	// oxlint-disable-next-line sister-software/no-process-globals -- this function is the blessed argv entry-path accessor
	return process.argv[1]!
}
