#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `astrogeology` runs the `fetch`, `build`, `verify`, and `publish` commands.
 *   The first positional argument selects a command.
 *   The rest are parsed using that command's spec.
 *   `--help` is handled before the command runs.
 */

import { cliArguments, parseArguments } from "@mailwoman/core/scripting/arguments"
import { optionPropertyName } from "@mailwoman/core/scripting/utils"
import { type CommandSpec, renderInkCommand, runNativeCommand } from "mailwoman/cli-kit"
import { type ComponentType, createElement } from "react"

/**
 * The spec and component exported by a command module.
 */
interface CommandModule {
	spec: CommandSpec
	default: ComponentType<{ options: unknown; args: unknown[] }>
}

/**
 * Commands are TSX, so Node cannot load them from source.
 *
 * Load compiled files from `out/commands/`; this path works from both `lib/` and `out/`.
 */
const COMMANDS_ROOT = new URL("../out/commands/", import.meta.url)

const COMMAND_NAMES = ["fetch", "build", "verify", "publish"] as const

type CommandName = (typeof COMMAND_NAMES)[number]

function loadCommand(name: CommandName): Promise<CommandModule> {
	return import(new URL(`${name}.js`, COMMANDS_ROOT).href) as Promise<CommandModule>
}

const USAGE = [
	"Usage: astrogeology <command> [options]",
	"",
	"Commands:",
	"  fetch    --body <moon|mars> [--kind nomenclature|dem]",
	"  build    --body <moon|mars> [--max-zoom 6] [--out <dir>]",
	"  verify   --body <moon|mars> [--out <dir>]",
	"  publish  --body <moon|mars> [--out <dir>] [--dry-run]",
	"",
	"Each command answers --help with its options.",
].join("\n")

function isCommandName(value: string | undefined): value is CommandName {
	return (COMMAND_NAMES as readonly string[]).includes(value ?? "")
}

async function main(): Promise<number> {
	const command = parseArguments({ strict: false, allowPositionals: true }).positionals[0]

	if (!isCommandName(command)) {
		process.stdout.write(`${USAGE}\n`)

		return command === undefined ? 0 : 2
	}

	const raw = cliArguments()
	const args = raw.slice(raw.findIndex((arg) => arg === command) + 1)
	const module = await loadCommand(command)

	return runNativeCommand(module.spec, args, (parsed) => {
		const options = Object.fromEntries(
			Object.entries(parsed.values).map(([name, value]) => [optionPropertyName(name), value])
		)

		return renderInkCommand(createElement(module.default, { options, args: parsed.positionals }))
	})
}

process.exitCode = await main()
