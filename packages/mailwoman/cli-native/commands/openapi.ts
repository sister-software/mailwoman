/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type CommandSpec, parseCommand, renderCommandHelp } from "../spec.ts"

/**
 * Native OpenAPI command contract.
 */
export const spec = {
	name: "openapi",
	description: "Emit the native @mailwoman/api OpenAPI document.",
	options: {
		flavor: {
			type: "string",
			default: "3.1",
			choices: ["3.1", "3.0"],
			description: "OpenAPI 3.1.0, or the compatibility-oriented 3.0.3 document.",
		},
		out: { type: "string", hint: "path", description: "Write to this path instead of stdout." },
	},
} as const satisfies CommandSpec

/**
 * Run `mw openapi` without loading React, Ink, or the parser/resolver stack.
 */
export async function run(args: readonly string[]): Promise<number> {
	const parsed = parseCommand(spec, args)

	if (parsed.values.help) {
		process.stdout.write(`${await renderCommandHelp(spec)}\n`)

		return 0
	}

	const [{ createMailwomanAPI, MAILWOMAN_API_DOC_INFO }, { printOpenAPIDocument }] = await Promise.all([
		import("@mailwoman/api"),
		import("@mailwoman/api-kit"),
	])

	const app = createMailwomanAPI({})
	const flavor = parsed.values.flavor as "3.1" | "3.0"
	const out = typeof parsed.values.out === "string" ? parsed.values.out : undefined

	await printOpenAPIDocument(app, MAILWOMAN_API_DOC_INFO, { flavor, out })

	return 0
}
