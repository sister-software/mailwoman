/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CLIUsageError, type CommandSpec, parseCommand, renderCommandHelp } from "../spec.ts"

/**
 * Native FST autocomplete command contract.
 */
export const spec = {
	name: "autocomplete",
	description: "Return ranked place-name completions for a prefix from the FST gazetteer.",
	positionals: [{ name: "prefix", description: "Prefix string to complete.", multiple: true }],
	options: {
		limit: {
			type: "number",
			default: 10,
			description: "Maximum number of completions.",
			validate: (value) => Number.isInteger(value) && value >= 1 && value <= 100,
			validationMessage: "--limit must be an integer between 1 and 100.",
		},
		fst: { type: "string", hint: "path", description: "FST binary; defaults from $MAILWOMAN_FST_BIN." },
		json: { type: "boolean", default: false, description: "Emit a JSON array instead of formatted text." },
	},
} as const satisfies CommandSpec

/**
 * Run `mw autocomplete` without React, Ink, or Zod.
 */
export async function run(args: readonly string[]): Promise<number> {
	const parsed = parseCommand(spec, args)

	if (parsed.values.help) {
		process.stdout.write(`${await renderCommandHelp(spec)}\n`)

		return 0
	}

	const prefix = parsed.positionals.join(" ").trim()

	if (!prefix) throw new CLIUsageError("autocomplete requires a prefix (for example mw autocomplete new yo).")

	const { formatAutocomplete, resolveFSTPath, runAutocomplete } = await import("#autocomplete-core")
	const fstPath = resolveFSTPath(typeof parsed.values.fst === "string" ? parsed.values.fst : undefined)
	const entries = await runAutocomplete(prefix, { fstPath, limit: parsed.values.limit as number })
	const output = parsed.values.json ? JSON.stringify(entries, null, 2) : formatAutocomplete(entries)

	process.stdout.write(`${output}\n`)

	return 0
}
