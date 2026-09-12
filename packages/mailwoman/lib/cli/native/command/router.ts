import { readDirectoryEntries, readLocalTextFile, tryStat } from "@mailwoman/core/fs/readers"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { createElement } from "react"
import type { ComponentType } from "react"

import { commandPathCandidates, declaredCommandName, isPrefixDirectory } from "#cli/native/command/names"
import { CLIUsageError, type CommandSpec, parseCommand, renderCommandHelp, renderInkCommand } from "#cli/native/spec"

interface CommandModule {
	spec?: CommandSpec
	default?: ComponentType<{ options: unknown; args: unknown[] }>
}

/**
 * The COMPILED command tree, whichever tree this module runs from. The commands are TSX, which Node cannot load from
 * source, so the router reads `out/commands/` even when the package's `#` imports have handed it the source router —
 * the same reach `geocode-stream.ts` makes for its worker.
 *
 * Anchored at the PACKAGE, not counted in `..` from this file. The count is a statement about this module's depth,
 * which is not something this module gets to know: moving it one directory deeper turned `../../out/commands/` into
 * `lib/cli/out/commands/`, and every command became `Unknown command` at once.
 */
const COMMANDS_ROOT = pathToFileURL(`${String(resolvePackagePath("mailwoman", "out", "commands"))}/`)

const commandURL = (parts: readonly string[], index = false): URL =>
	new URL(`${parts.join("/")}${index ? "/index" : ""}.js`, COMMANDS_ROOT)

/**
 * Kebab segments whose property spelling capitalizes the whole acronym, per the house casing convention.
 *
 * A segment missing here derives a property the command's own `Options` does not declare. The flag still parses and
 * still passes validation; it reaches the component under a name nothing reads, so it does nothing and reports no
 * error. Add the segment here when a flag carries an acronym.
 */
const OPTION_INITIALISMS = new Map([
	["csv", "CSV"],
	["db", "DB"],
	["html", "HTML"],
	["ids", "IDs"],
	["json", "JSON"],
	["jsonl", "JSONL"],
	["km", "KM"],
	["svg", "SVG"],
	["xml", "XML"],
])

/**
 * Convert a kebab-case option name to its TypeScript property name.
 */
export function optionPropertyName(value: string): string {
	const [head = "", ...tail] = value.split("-")

	return (
		head +
		tail.map((part) => OPTION_INITIALISMS.get(part) ?? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("")
	)
}

/**
 * The command names one directory of the compiled tree offers — what a user types, not what the files are called.
 *
 * A prefix directory contributes its children as `<directory>-<child>` rather than itself, because that is the name
 * they answer to. `listCommandNames` is help-only, so reading one extra directory level costs nothing anyone waits on.
 */
async function listCommandNames(directory: URL): Promise<string[]> {
	const entries = await readDirectoryEntries(directory)
	const names: string[] = []

	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".js") && entry.name !== "index.js") {
			names.push(entry.name.replace(/\.js$/u, ""))

			continue
		}

		if (!entry.isDirectory()) continue

		const nested = new URL(`${entry.name}/`, directory)
		const children = await readDirectoryEntries(nested)
		const hasIndex = children.some((child) => child.isFile() && child.name === "index.js")

		const commands = children.filter(
			(child) => child.isFile() && child.name.endsWith(".js") && child.name !== "index.js"
		)

		// A prefix directory offers no command of its own, and every command under it declares the directory's name as
		// its own prefix. The declared name is what decides it: a namespace like `gazetteer/inspect/` looks identical
		// from the outside, and only the specs tell them apart.
		const declared = hasIndex
			? []
			: await Promise.all(
					commands.map(async (child) =>
						declaredCommandName(await readLocalTextFile(new URL(child.name, nested)), child.name.replace(/\.js$/u, ""))
					)
				)

		if (declared.length && declared.every((name) => isPrefixDirectory(entry.name, name))) {
			names.push(...declared)

			continue
		}

		names.push(entry.name)
	}

	return names
}

/**
 * The path segments one typed command name resolves to under `within`, or nothing when it names no command.
 *
 * The literal spelling is tried first, so a command whose file sits where its name says is one `stat`. Only then are
 * the prefix-directory readings tried — `postcode-codepoint` as `postcode/codepoint` — which is what lets the layout
 * change without renaming anything the user types.
 */
async function resolveSegment(within: readonly string[], segment: string): Promise<string[] | undefined> {
	for (const candidate of commandPathCandidates(segment)) {
		const parts = [...within, ...candidate]

		if ((await tryStat(commandURL(parts))) || (await tryStat(commandURL(parts, true)))) return candidate

		if (await tryStat(new URL(`${parts.join("/")}/`, COMMANDS_ROOT))) return candidate
	}

	return undefined
}

async function runCommand(module: CommandModule, commandPath: string, argv: readonly string[]): Promise<number> {
	if (!module.spec) throw new TypeError(`Command ${commandPath} does not export a CommandSpec.`)

	if (!module.default) throw new TypeError(`Command ${commandPath} has no executable component.`)
	const parsed = parseCommand(module.spec, argv)

	if (parsed.values.help === true) {
		process.stdout.write(`${await renderCommandHelp({ ...module.spec, name: commandPath })}\n`)

		return 0
	}

	const options = Object.fromEntries(
		Object.entries(parsed.values).map(([name, value]) => [optionPropertyName(name), value])
	)

	return await renderInkCommand(createElement(module.default, { options, args: parsed.positionals }))
}

async function groupHelp(parts: readonly string[]): Promise<number> {
	const commands = (await listCommandNames(new URL(`${parts.join("/")}/`, COMMANDS_ROOT))).toSorted()

	process.stdout.write(`Usage: mw ${parts.join(" ")} <command> [options]\n\nCommands:\n`)

	for (const command of commands) {
		process.stdout.write(`  ${command}\n`)
	}

	return 0
}

async function rootHelp(): Promise<number> {
	const filesystemCommands = await listCommandNames(COMMANDS_ROOT)

	const { nativeCommandRoutes } = await import("#cli/native/router")
	const commands = new Map(filesystemCommands.map((name) => [name, ""]))

	for (const [name, route] of Object.entries(nativeCommandRoutes)) {
		commands.set(name, route.summary)
	}

	process.stdout.write("Usage: mw <command> [options]\n\nCommands:\n")

	for (const [name, summary] of [...commands].toSorted(([a], [b]) => a.localeCompare(b))) {
		process.stdout.write(`  ${name.padEnd(18)}${summary}\n`)
	}

	process.stdout.write("\nOptions:\n  -h, --help        Show help.\n  -v, --version     Show version.\n")

	return 0
}

export async function dispatchCommand(argv: readonly string[]): Promise<number> {
	if (!argv.length || argv[0] === "--help" || argv[0] === "-h") return rootHelp()
	const commandParts: string[] = []

	// The path each accepted segment resolved to, which is the command's LOCATION. It parts company with
	// `commandParts` — the name the user typed — the moment a prefix directory stands between them.
	const filesystemParts: string[] = []

	for (const value of argv) {
		if (value.startsWith("-")) break

		const resolved = await resolveSegment(filesystemParts, value)

		if (!resolved) break

		filesystemParts.push(...resolved)
		commandParts.push(value)
	}

	if (!commandParts.length) throw new CLIUsageError(`Unknown command: ${argv[0] ?? "(none)"}.`)
	const direct = commandURL(filesystemParts)
	const index = commandURL(filesystemParts, true)
	const selected = (await tryStat(direct)) ? direct : (await tryStat(index)) ? index : undefined

	if (!selected) return groupHelp(filesystemParts)

	return import(selected.href).then((module) =>
		runCommand(module, commandParts.join(" "), argv.slice(commandParts.length))
	)
}
