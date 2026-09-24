#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   CLI entry point. Runs the preamble before dynamically importing command code.
 */

import { enableCompileCache } from "@mailwoman/core/module/runtime"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

// Attempt to cache compiled code to speed up each CLI run.
try {
	enableCompileCache()
} catch {}

// Default to React's production build for CLI runs. Preserve `NODE_ENV=test` when set by vitest.
// oxlint-disable-next-line sister-software/no-process-globals -- See above
process.env.NODE_ENV ??= "production"

// Start the clock before command imports so geocode's --timing report includes them.
globalThis.__mailwomanCLIStartedAt = performance.now()

// Commands have different flags, so leave unknown options for the command router to handle.
const { values, positionals } = parseArguments({
	options: {
		help: { type: "boolean", short: "h" },
		timing: { type: "boolean", short: "t" },
		version: { type: "boolean", short: "v" },
	},
	strict: false,
	allowPositionals: true,
})

// Handle --version here only when no command was given.
// When a command is given, that command owns the flag.
const rootVersionRequest = values.version === true && !positionals.length

// Show feedback while an interactive geocode command loads.
const interactiveGeocode =
	process.stderr.isTTY === true && positionals[0] === "geocode" && !values.help && !values.timing

if (interactiveGeocode) {
	console.error("[geocode] Loading command…")
}

async function printVersion(): Promise<number> {
	const { readMailwomanVersion } = await import("#cli/kit/metadata")

	process.stdout.write(`${await readMailwomanVersion()}\n`)

	return 0
}

function dispatchCommand(): Promise<number> {
	const runnerModule = import("@mailwoman/core/scripting/command")
	const routerModule = import("#cli/native/router")
	const commandRouterModule = import("#cli/native/command/router")
	const argumentsModule = import("@mailwoman/core/scripting/arguments")

	return Promise.all([runnerModule, routerModule, commandRouterModule, argumentsModule]).then(
		([
			{ runCLICommand },
			{ dispatchNativeCommand },
			{ dispatchCommand: dispatchFilesystemCommand },
			{ cliArguments },
		]) => {
			const launchArguments = cliArguments()

			return runCLICommand(() =>
				dispatchNativeCommand(launchArguments).then((exitCode) => {
					return exitCode ?? dispatchFilesystemCommand(launchArguments)
				})
			).then((exitCode) => exitCode ?? 0)
		}
	)
}

const exitCode = await (rootVersionRequest ? printVersion() : dispatchCommand())

// Print the notice only in the cluster primary.
// Notice failures go to stderr and do not change the command's exit code.
// Use a builtin to avoid another static import.
// Workers should not print duplicate notices.
if (process.getBuiltinModule("node:cluster").isPrimary) {
	try {
		const { printLicenseNotice, resolveEngineStamp } = await import("#cli/kit/engine-stamp")

		printLicenseNotice(await resolveEngineStamp())
	} catch (error) {
		const { errorMessage } = await import("@mailwoman/core/errors")

		console.error(`[license] posture unavailable: ${errorMessage(error)}`)
	}
}

process.exitCode = exitCode
