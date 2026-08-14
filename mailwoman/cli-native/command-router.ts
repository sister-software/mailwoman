import { access, readdir } from "node:fs/promises"

import { render } from "ink"
import { createElement } from "react"
import type { ComponentType } from "react"

import { CLIUsageError, type CommandSpec, parseCommand, renderCommandHelp } from "./spec.ts"

interface CommandModule {
	spec?: CommandSpec
	default?: ComponentType<{ options: unknown; args: unknown[] }>
}

const exists = (url: URL): Promise<boolean> =>
	access(url).then(
		() => true,
		() => false
	)

const commandURL = (parts: readonly string[], index = false): URL =>
	new URL(`../commands/${parts.join("/")}${index ? "/index" : ""}.js`, import.meta.url)

const camelCase = (value: string): string => value.replaceAll(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())

async function runCommand(module: CommandModule, commandPath: string, argv: readonly string[]): Promise<number> {
	if (!module.spec) throw new TypeError(`Command ${commandPath} does not export a CommandSpec.`)

	if (!module.default) throw new TypeError(`Command ${commandPath} has no executable component.`)
	const parsed = parseCommand(module.spec, argv)

	if (parsed.values.help === true) {
		process.stdout.write(`${await renderCommandHelp({ ...module.spec, name: commandPath })}\n`)

		return 0
	}

	const options = Object.fromEntries(Object.entries(parsed.values).map(([name, value]) => [camelCase(name), value]))
	const instance = render(createElement(module.default, { options, args: parsed.positionals }))
	await instance.waitUntilExit()

	return typeof process.exitCode === "number" ? process.exitCode : 0
}

async function groupHelp(parts: readonly string[]): Promise<number> {
	const entries = await readdir(new URL(`../commands/${parts.join("/")}/`, import.meta.url), { withFileTypes: true })

	const commands = entries
		.filter(
			(entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".js") && entry.name !== "index.js")
		)
		.map((entry) => entry.name.replace(/\.js$/u, ""))
		.toSorted()

	process.stdout.write(`Usage: mw ${parts.join(" ")} <command> [options]\n\nCommands:\n`)

	for (const command of commands) {
		process.stdout.write(`  ${command}\n`)
	}

	return 0
}

async function rootHelp(): Promise<number> {
	const entries = await readdir(new URL("../commands/", import.meta.url), { withFileTypes: true })

	const filesystemCommands = entries
		.filter(
			(entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".js") && entry.name !== "index.js")
		)
		.map((entry) => entry.name.replace(/\.js$/u, ""))

	const { nativeCommandRoutes } = await import("./router.ts")
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

	for (const value of argv) {
		if (value.startsWith("-")) break
		const candidate = [...commandParts, value]

		if ((await exists(commandURL(candidate))) || (await exists(commandURL(candidate, true)))) {
			commandParts.push(value)

			continue
		}

		if (await exists(new URL(`../commands/${candidate.join("/")}/`, import.meta.url))) {
			commandParts.push(value)

			continue
		}

		break
	}

	if (!commandParts.length) throw new CLIUsageError(`Unknown command: ${argv[0] ?? "(none)"}.`)
	const direct = commandURL(commandParts)
	const index = commandURL(commandParts, true)
	const selected = (await exists(direct)) ? direct : (await exists(index)) ? index : undefined

	if (!selected) return groupHelp(commandParts)

	return import(selected.href).then((module) =>
		runCommand(module, commandParts.join(" "), argv.slice(commandParts.length))
	)
}
