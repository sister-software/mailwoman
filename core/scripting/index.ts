import type { ScriptCallback } from "../utils/scripting.ts"

/**
 * Given a module's import.meta object, resolves if the module was run as a NPM script.
 *
 * ```ts
 * runIfScript(async () => {...})
 * ```
 *
 * This is useful for conditionally running scripts without too much boilerplate.
 *
 * @internal
 */
export async function runIfScript(scriptCallback: ScriptCallback): Promise<void> {
	if (typeof import.meta.main !== "boolean") {
		throw new Error("Expected import.meta.main to be a boolean. Are we on Node.js 24+?")
	}

	if (!import.meta.main) return

	const [{ $public }, { ConsoleLogger, stringifyLoggedObject }, { runScript }] = await Promise.all([
		import("@mailwoman/core/env"),
		import("@mailwoman/core/logging"),
		import("@mailwoman/core/scripting/utils"),
	])

	ConsoleLogger.info(
		stringifyLoggedObject($public, {
			description: "Public Environment",
			showValues: true,
		})
	)

	return runScript(scriptCallback)
}
