/**
 * Read compiled command modules and assemble their native command specifications.
 */

import { isDirectory } from "@mailwoman/core/fs/readers/stat"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { isPrefixDirectoryFor } from "mailwoman/cli/native/command/names"
import type { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

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
	spec: CommandSpec | null
	component: unknown
	commands: Map<string, CommandNode> | null
}

const MODULE_EXTENSION = /\.[cm]?js$/u

/**
 * A module under a command root that declares no command: a helper its sibling command imports.
 */
function isHelperModule(node: CommandNode): boolean {
	return node.spec === null && node.component === null && node.commands === null
}

/**
 * Read the command tree under a compiled command root.
 *
 * Files are read before directories, each in name order, so the tree is the same
 * whatever order the filesystem lists the entries.
 * A directory beside a command file of the same name holds that command's helpers,
 * and its subcommands when it has any: `license/attribution.js` is a module `license.js`
 * imports, and the tree keeps `license` as the command the file declares.
 *
 * A directory whose modules declare no command is layout, and the tree stays as it was
 * before the directory was read.
 */
export async function readCommands(
	directory: PathBuilder,
	ignoredEntries: ReadonlySet<string> = new Set()
): Promise<Map<string, CommandNode>> {
	const commands = new Map<string, CommandNode>()

	const entries = await Globerator.from("*", { cwd: directory, absolute: false, onlyFiles: false })
		.filter((entry) => !ignoredEntries.has(entry.replace(MODULE_EXTENSION, "")))
		.toSorted((a, b) => a.localeCompare(b, "en"))

	const directories: string[] = []

	for (const entry of entries) {
		const path = directory(entry)

		if (await isDirectory(path)) {
			directories.push(entry)

			continue
		}

		if (!MODULE_EXTENSION.test(entry) || entry.endsWith(".d.js")) continue
		const module = (await import(pathToFileURL(path).href)) as { spec?: CommandSpec; default?: unknown; run?: unknown }
		const fileName = entry.replace(MODULE_EXTENSION, "")
		// The declared name, so a file that moves into a prefix directory keeps the name users type.
		// `index` is the one exception.
		// It identifies a position rather than a name.
		// The parent folds it into the directory's own entry.
		const name = fileName === "index" ? fileName : (module.spec?.name ?? fileName)

		const executable = module.default ?? module.run

		if (executable && !module.spec) throw new TypeError(`Command module ${path} does not export a CommandSpec.`)

		const node: CommandNode = {
			name,
			spec: module.spec ?? null,
			component: executable ?? null,
			commands: null,
		}

		if (isHelperModule(node)) continue

		commands.set(name, node)
	}

	for (const entry of directories) {
		const children = await readCommands(directory(entry))
		const index = children.get("index")

		if (index) {
			children.delete("index")
			commands.set(entry, { ...index, name: entry, commands: children })

			continue
		}

		if (!children.size) continue

		// A prefix directory is layout rather than a command path: every command under it
		// declares the directory's own name as its prefix, so `build/postcode/codepoint.js` is
		// `build postcode-codepoint` and the directory itself is a path segment the user never types.
		// A namespace directory looks identical from outside.
		// The declared names decide, by the same rule the native router applies.
		const nested = [...children.values()]

		if (
			nested.every((child) => !child.commands) &&
			isPrefixDirectoryFor(
				entry,
				nested.map((child) => child.name)
			)
		) {
			for (const child of nested) {
				commands.set(child.name, child)
			}

			continue
		}

		const sibling = commands.get(entry)

		if (sibling) {
			commands.set(entry, { ...sibling, commands: children })

			continue
		}

		commands.set(entry, { name: entry, spec: null, component: null, commands: children })
	}

	return commands
}
