/**
 * Read compiled command modules and assemble their native command specifications.
 */

import { isDirectory, readDirectory } from "@mailwoman/core/fs/readers"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { join } from "path-ts"

export interface OptionSpec {
	type: "boolean" | "string" | "number"
	description: string
	default?: unknown
	required?: boolean
	multiple?: boolean
	choices?: readonly string[]
}

export interface PositionalSpec {
	name: string
	description: string
	required?: boolean
	multiple?: boolean
	choices?: readonly string[]
}

export interface CommandSpec {
	name: string
	description: string
	options?: Readonly<Record<string, OptionSpec>>
	positionals?: readonly PositionalSpec[]
}

export interface CommandNode {
	name: string
	spec?: CommandSpec
	component?: unknown
	commands?: Map<string, CommandNode>
}

export async function readCommands(
	directory: string,
	ignoredEntries: ReadonlySet<string> = new Set()
): Promise<Map<string, CommandNode>> {
	const commands = new Map<string, CommandNode>()

	for (const entry of await readDirectory(directory)) {
		if (ignoredEntries.has(entry.replace(/\.[cm]?js$/u, ""))) continue
		const path = join(directory, entry)

		if (await isDirectory(path)) {
			const children = await readCommands(path)
			const index = children.get("index")

			if (index) {
				children.delete("index")
				commands.set(entry, { ...index, name: entry, commands: children })

				continue
			}

			// A PREFIX DIRECTORY is layout, not a command path: every command under it declares the directory's own name
			// as its prefix, so `build/postcode/codepoint.js` is `build postcode-codepoint` and the directory itself is
			// not something a user types. A namespace directory looks identical from outside; the declared names decide.
			const nested = [...children.values()]

			if (nested.length && nested.every((child) => !child.commands && child.name.startsWith(`${entry}-`))) {
				for (const child of nested) {
					commands.set(child.name, child)
				}

				continue
			}

			commands.set(entry, { name: entry, commands: children })

			continue
		}

		if (!/\.[cm]?js$/u.test(entry) || entry.endsWith(".d.js")) continue
		const module = (await import(pathToFileURL(path).href)) as { spec?: CommandSpec; default?: unknown; run?: unknown }
		const fileName = entry.replace(/\.[cm]?js$/u, "")
		// The DECLARED name, so a file that moves into a prefix directory keeps the name users type. `index` is the one
		// exception: it is a position, not a name, and the parent folds it into the directory's own entry.
		const name = fileName === "index" ? fileName : (module.spec?.name ?? fileName)

		const executable = module.default ?? module.run

		if (executable && !module.spec) throw new TypeError(`Command module ${path} does not export a CommandSpec.`)

		commands.set(name, {
			name,
			...(module.spec ? { spec: module.spec } : {}),
			...(executable ? { component: executable } : {}),
		})
	}

	return commands
}
