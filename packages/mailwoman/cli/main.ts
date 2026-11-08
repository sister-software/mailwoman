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
	const { readMailwomanVersion } = await import("#metadata")

	process.stdout.write(`${await readMailwomanVersion()}\n`)

	return 0
}

function dispatchCommand(): Promise<number> {
	const runnerModule = import("@mailwoman/core/scripting/command")
	const localityModule = import("@mailwoman/core/module/checkout-locality")

	return Promise.all([runnerModule, localityModule]).then(([{ runCLICommand }, { assertCheckoutLocality }]) =>
		runCLICommand(async () => {
			// In a repository checkout, refuse to run on another checkout's packages
			// before the command graph loads.
			// An installed CLI's core sits in no working tree, so the guard answers after a few stats.
			await assertCheckoutLocality(import.meta.dirname)

			const [{ dispatchNativeCommand }, { dispatchCommand: dispatchFilesystemCommand }, { cliArguments }] =
				await Promise.all([
					import("#cli/native/router"),
					import("#cli/native/command/router"),
					import("@mailwoman/core/scripting/arguments"),
				])

			const launchArguments = cliArguments()

			return (await dispatchNativeCommand(launchArguments)) ?? dispatchFilesystemCommand(launchArguments)
		}).then((exitCode) => exitCode ?? 0)
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
