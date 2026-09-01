import { defaultRegistry } from "async-init"

import { ResourceError } from "#errors/schema"
import { ConsoleLogger } from "#logging"

export { cliArguments, passThroughCLIArguments, scriptEntryPath } from "#scripting/arguments"

/**
 * Print a message to stderr and exit non-zero. Typed `never`, so a caller gets definite-assignment narrowing after the
 * call.
 */
export function failScript(message: string): never {
	process.stderr.write(`${message}\n`)

	process.exit(1)
}

/**
 * Logs an error that occurred while running a script.
 */
export function logScriptError(error: unknown): void {
	ConsoleLogger.error("An error occurred while running the script.")

	const normalizedError = error instanceof ResourceError ? error : ResourceError.wrap(error)

	ConsoleLogger.error(normalizedError)

	if (normalizedError.cause instanceof Error && normalizedError.cause.stack) {
		ConsoleLogger.error("Stack via cause:\n" + normalizedError.cause.stack)
	} else if (normalizedError.stack) {
		ConsoleLogger.error("Stack:\n" + normalizedError.stack)
	}
}

/**
 * A script callback function to invoke.
 *
 * @internal
 */
export type ScriptCallback = (...args: unknown[]) => unknown | Promise<unknown>

/**
 * Cleans up services and exits the script cleanly.
 *
 * @param exitCode - Explicit exit code; when omitted, whatever `process.exitCode` the script set (default 0) stands.
 * @internal
 */
export function postScriptCleanup(signal: NodeJS.Signals = "SIGTERM", exitCode?: number): Promise<void> {
	ConsoleLogger.debug(`\n[${signal}] Shutting down...`)

	const timeout = setTimeout(() => {
		ConsoleLogger.error("Script did not exit in a timely manner.")

		process.exit(1)
	}, 15_000)

	return defaultRegistry[Symbol.asyncDispose]()
		.catch(logScriptError)
		.finally(() => {
			clearTimeout(timeout)
			process.exit(exitCode ?? process.exitCode ?? 0)
		})
}

/**
 * Runs a script callback and handles cleanup. A callback that throws exits 1; a clean return exits with
 * `process.exitCode` (default 0).
 *
 * @internal
 */
export function runScript(scriptCallback: ScriptCallback): Promise<void> {
	process.on("SIGINT", postScriptCleanup)
	process.on("SIGTERM", postScriptCleanup)

	return Promise.resolve()
		.then(() => scriptCallback())
		.then(
			() => postScriptCleanup(),
			(error) => {
				logScriptError(error)

				return postScriptCleanup("SIGTERM", 1)
			}
		)
		.catch(() => postScriptCleanup("SIGTERM", 1))
}

/**
 * The ONE blessed way to build a child-process environment: the current environment with explicit overrides. Everything
 * outside `core/env` + this module is forbidden from touching `process.env` directly (enforced by
 * `scripts/lint-raw-env-argv.ts`) — read config through `$public`/`$private`.
 */
export function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	// oxlint-disable-next-line sister-software/no-process-globals -- this function is the blessed child-process environment boundary
	return { ...process.env, ...overrides }
}
