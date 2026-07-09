import type { ScriptCallback } from "../utils/scripting.ts"

/**
 * Given the calling module's import.meta object, runs the callback if that module is the entry script.
 *
 * ```ts
 * runIfScript(import.meta, async () => {...})
 * ```
 *
 * The caller's meta is required: `import.meta.main` is per-module, so checking our own would always be false. This is
 * useful for conditionally running scripts without too much boilerplate.
 *
 * @internal
 */
export async function runIfScript(meta: ImportMeta, scriptCallback: ScriptCallback): Promise<void> {
	if (typeof meta.main !== "boolean") {
		// Vite/vitest module graphs define import.meta.env but never import.meta.main — a module
		// imported there is not the entry script, so importing it must stay side-effect-free.
		if ((meta as { env?: unknown }).env) return

		throw new Error("Expected import.meta.main to be a boolean. Are we on Node.js 24+?")
	}

	if (!meta.main) return

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
