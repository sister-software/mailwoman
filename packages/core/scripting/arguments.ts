/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Dependency-free process argument accessors. Kept separate from script cleanup/logging so latency-sensitive CLI
 * dispatchers can read argv without loading the ResourceError, ConsoleLogger, and async-init graphs.
 */

import { parseArgs, type ParseArgsConfig } from "node:util"

export type { ParseArgsConfig } from "node:util"

export type UnsafeCLIArgument = string & { __unsafeCLIArgumentBrand: never }

export type UnsafeCLIArguments = ReadonlyArray<UnsafeCLIArgument>

/**
 * The one blessed accessor for user CLI arguments.
 */
export function cliArguments(): UnsafeCLIArguments {
	// Element-wise: `string[] as ReadonlyArray<Branded>` is not a legal assertion, while `string as Branded` is —
	// which is the whole reason this accessor exists rather than the brand being minted at each call site.
	// oxlint-disable-next-line sister-software/no-process-globals -- this function is the blessed argv accessor
	return process.argv.slice(2).map((value) => value as UnsafeCLIArgument)
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

/**
 * Parse CLI arguments against a `node:util` `parseArgs` config — the same `options`, `allowPositionals`, `strict` and
 * `tokens` fields. `args` defaults to {@linkcode cliArguments}, so a script never reads `process.argv` itself; a caller
 * that has already taken a command name off the front passes the remainder as `args` and it is used as given. The
 * result is typed from the config exactly as the builtin types it.
 */
/**
 * A flag's value, or a thrown error naming the flag and the command that needs it.
 *
 * `parseArgs` has no required-option concept: an absent `--name` is `undefined`, and a script that forwards that into a
 * path or a URL fails far from the flag that caused it.
 */
export function requiredArgument(scope: string, name: string, value: string | undefined): string {
	if (value === undefined) {
		throw new Error(`${scope}: --${name} is required`)
	}

	return value
}

export function parseArguments<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
	// The builtin types its result from the whole config object, so supplying `args` moves the type; the parsed shape
	// depends on `options`/`allowPositionals` alone, which `T` carries.
	return parseArgs({ args: [...cliArguments()], ...config }) as ReturnType<typeof parseArgs<T>>
}
