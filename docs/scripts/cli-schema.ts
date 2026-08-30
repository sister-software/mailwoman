/**
 * Read compiled command modules and assemble their native command specifications.
 */

import { isDirectory } from "@mailwoman/core/fs/readers"
import { readdir } from "@mailwoman/platform/fs/promises"
import { join } from "@mailwoman/platform/path"
import { pathToFileURL } from "@mailwoman/platform/url"

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

	for (const entry of await readdir(directory)) {
		if (ignoredEntries.has(entry.replace(/\.[cm]?js$/u, ""))) continue
		const path = join(directory, entry)

		if (await isDirectory(path)) {
			const children = await readCommands(path)
			const index = children.get("index")

			if (index) {
				children.delete("index")
				commands.set(entry, { ...index, name: entry, commands: children })
			} else {
				commands.set(entry, { name: entry, commands: children })
			}

			continue
		}

		if (!/\.[cm]?js$/u.test(entry) || entry.endsWith(".d.js")) continue
		const module = (await import(pathToFileURL(path).href)) as { spec?: CommandSpec; default?: unknown; run?: unknown }
		const name = entry.replace(/\.[cm]?js$/u, "")

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
