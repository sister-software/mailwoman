import { ResourceError } from "../../errors/index.js"
import { ServiceRepository } from "../../lifecycle/index.js"
import { ConsoleLogger } from "../../logging/index.js"

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
		ConsoleLogger.error("Stack via cause:\n" + normalizedError.stack)
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
 * @internal
 */
export function postScriptCleanup(signal: NodeJS.Signals = "SIGTERM", exitCode = 0): Promise<void> {
	ConsoleLogger.debug(`\n[${signal}] Shutting down...`)

	const timeout = setTimeout(() => {
		ConsoleLogger.error("Script did not exit in a timely manner.")

		ServiceRepository.abortController.abort(signal)

		const services = ServiceRepository.inspect()
		ConsoleLogger.warn(services, `${services.length} did not dispose.`)

		process.exit(1)
	}, 15_000)

	return ServiceRepository.dispose()
		.catch(logScriptError)
		.finally(() => {
			clearTimeout(timeout)
			process.exit(exitCode)
		})
}

/**
 * Runs a script callback and handles cleanup.
 *
 * @internal
 */
export function runScript(scriptCallback: ScriptCallback): Promise<void> {
	process.on("SIGINT", postScriptCleanup)
	process.on("SIGTERM", postScriptCleanup)

	return Promise.resolve()
		.then(() => scriptCallback())
		.catch(logScriptError)
		.then(() => postScriptCleanup())
		.catch(() => postScriptCleanup("SIGTERM", 1))
}

/**
 * The ONE blessed accessor for CLI arguments. Everything outside `core/env` + this module is forbidden from touching
 * `process.argv` directly (enforced by the `sister-software/no-process-globals` oxlint rule) — prefer `node:util`
 * `parseArgs` (which reads this same slice by default) and reach for this only where `parseArgs` cannot express the
 * grammar (e.g. negative-coordinate positionals).
 */
export function cliArguments(): string[] {
	// oxlint-disable-next-line sister-software/no-process-globals
	return process.argv.slice(2)
}

/**
 * The ONE blessed way to build a child-process environment: the current environment with explicit overrides. Everything
 * outside `core/env` + this module is forbidden from touching `process.env` directly (enforced by
 * `scripts/lint-raw-env-argv.ts`) — read config through `$public`/`$private`.
 */
export function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	// oxlint-disable-next-line sister-software/no-process-globals
	return { ...process.env, ...overrides }
}

/** The path of the executing script (`argv[1]`) — for commands that re-spawn or reference their own CLI entry. */
export function scriptEntryPath(): string {
	// oxlint-disable-next-line sister-software/no-process-globals
	return process.argv[1]!
}
