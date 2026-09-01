/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Dependency-light lifecycle and error primitives for user-facing CLI commands. This is intentionally separate from
 * `scripting/utils`, whose service disposal and structured logging are appropriate for long-running scripts.
 */

/**
 * An expected command failure whose message is safe to show directly. The original failure belongs in `cause`.
 */
export class CommandError extends Error {
	readonly exitCode = 1

	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "CommandError"
	}
}

/**
 * Format an expected command failure as guidance and preserve stacks for unexpected failures.
 */
export function formatCommandError(error: unknown): string {
	if (error instanceof CommandError) return error.message

	return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/**
 * Log a command failure and the cause attached to expected guidance errors.
 */
export function reportError(error: unknown): void {
	console.error(formatCommandError(error))

	if (error instanceof CommandError && error.cause !== undefined) {
		console.error(`Caused by: ${formatCommandError(error.cause)}`)
	}
}

/**
 * Run a CLI command with one consistent stderr and exit-code boundary.
 */
export function runCLICommand(
	command: () => number | undefined | Promise<number | undefined>
): Promise<number | undefined> {
	return Promise.resolve()
		.then(command)
		.catch((error: unknown) => {
			reportError(error)

			return 1
		})
}
