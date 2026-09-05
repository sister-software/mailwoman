#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CLI's bin entry. It runs the process-wide preamble before selecting and importing one command.
 *
 *   The split is required. ESM evaluates every static import before a module's own body runs, so a preamble
 *   written in a statically imported command graph would execute after that graph had already initialized. Only
 *   `node:module` is imported statically here; command code arrives through dynamic imports after this body.
 *
 *   So keep this file at one static import: anything added to the top of it is compiled before the cache exists and,
 *   if it reaches React, pins the development build.
 */

import { enableCompileCache } from "@mailwoman/core/module/runtime"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

// The CLI compiles ~16 MB of source per invocation, and the loader/compiler/GC are ~85% of a `--help` run. V8's
// on-disk code cache removes most of it: `--help` 1.34 s → 0.99 s, `parse` 2.95 s → 2.63 s. The cache is
// content-addressed and self-invalidating, so a stale entry is not a failure mode; an unwritable cache directory is,
// and a CLI that cannot cache its compilation is a slow CLI rather than a broken one.
try {
	enableCompileCache()
} catch {}

// React's CJS entry picks its development or production build from `NODE_ENV` at import time, and the development
// build is 23.5% of the render work in `geocode --debug`'s interactive session: 12.35 ms → 4.25 ms of synchronous
// main-thread work per keystroke at 120×36. Nothing in the CLI reads React's dev warnings, so production is the right
// default — `??=` and not `=`, because vitest sets `NODE_ENV=test` and `core/env` models all three values.
// oxlint-disable-next-line sister-software/no-process-globals -- See above
process.env.NODE_ENV ??= "production"

// The geocode command's --timing report needs a clock that starts before command dependencies are imported.
// Keeping the stamp here lets it attribute the otherwise invisible CLI import graph without putting a
// profiling dependency in this deliberately tiny launcher.
globalThis.__mailwomanCLIStartedAt = performance.now()

// `strict: false` is required, not a relaxation: the launcher cannot enumerate the union of every command's flags, and
// a strict parse rejects the first one it has not heard of — `--json`, `--locale`, `--debug` — before dispatch, which
// is the whole CLI rather than one command. Unknown options stay in the vector for the command router to interpret.
const { values, positionals } = parseArguments({
	options: {
		help: { type: "boolean", short: "h" },
		timing: { type: "boolean", short: "t" },
		version: { type: "boolean", short: "v" },
	},
	strict: false,
	allowPositionals: true,
})

// A ROOT version request, which is why the positional count is required: `--version` reached from anywhere in the
// vector would make the launcher answer `mw geocode --version` itself, swallowing a flag that belongs to the command.
const rootVersionRequest = values.version === true && !positionals.length

// Give an interactive geocode invocation feedback before its model and resolver graph loads.
const interactiveGeocode =
	process.stderr.isTTY === true && positionals[0] === "geocode" && !values.help && !values.timing

if (interactiveGeocode) {
	console.error("[geocode] Loading command…")
}

async function printVersion(): Promise<number> {
	const { readMailwomanVersion } = await import("#cli-kit/metadata")

	process.stdout.write(`${await readMailwomanVersion()}\n`)

	return 0
}

function dispatchCommand(): Promise<number> {
	const runnerModule = import("@mailwoman/core/scripting/command")
	const routerModule = import("#cli-native/router")
	const commandRouterModule = import("#cli-native/command-router")
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

// The notice is the last thing written, for every command and every exit code, and it never changes the exit code: a
// failure to build it is reported on stderr and the command's own result stands.
try {
	const { printLicenseNotice, resolveEngineStamp } = await import("#cli-kit/engine-stamp")

	printLicenseNotice(await resolveEngineStamp())
} catch (error) {
	console.error(`[license] posture unavailable: ${error instanceof Error ? error.message : String(error)}`)
}

process.exitCode = exitCode
