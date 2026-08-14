#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CLI's bin entry. It runs the process-wide preamble before selecting and importing one command.
 *
 *   The split is load-bearing. ESM evaluates every static import before a module's own body runs, so a preamble
 *   written in a statically imported command graph would execute after that graph had already initialized. Only
 *   `node:module` is imported statically here; command code arrives through dynamic imports after this body.
 *
 *   So keep this file at one static import: anything added to the top of it is compiled before the cache exists and,
 *   if it reaches React, pins the development build.
 */

import { enableCompileCache, findPackageJSON } from "node:module"

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
//
// `@mailwoman/core/env` is the blessed READER of a live view over `process.env`; it has no writer, and importing one
// here would defeat the point of this file. The `readonly NODE_ENV` in `mailwoman/types/node.d.ts` guards against a
// library mutating the ambient environment out from under the process — this is the process's own entry point, ahead
// of the first reader, which is the one place the guard is not aimed at.
// oxlint-disable-next-line sister-software/no-process-globals -- see above.
const environment = process.env as { NODE_ENV?: string }

environment.NODE_ENV ??= "production"

// The geocode command's --timing report needs a clock that starts before command dependencies are imported.
// Keeping the stamp here lets it attribute the otherwise invisible CLI import graph without putting a
// profiling dependency in this deliberately tiny launcher.
;(globalThis as { __mailwomanCLIStartedAt?: number }).__mailwomanCLIStartedAt = performance.now()

// Give an interactive geocode invocation feedback before its model and resolver graph loads.
const { cliArguments } = await import("@mailwoman/core/scripting/arguments")
const launchArguments = cliArguments()

const interactiveGeocode =
	process.stderr.isTTY === true &&
	launchArguments[0] === "geocode" &&
	!launchArguments.includes("--help") &&
	!launchArguments.includes("-h") &&
	!launchArguments.includes("--timing")

if (interactiveGeocode) {
	console.error("[geocode] Loading command…")
}

const rootVersionRequest = launchArguments.length === 1 && ["--version", "-v"].includes(launchArguments[0]!)

async function printVersion(): Promise<number> {
	const packageJSONPath = findPackageJSON(import.meta.url)

	if (!packageJSONPath) throw new Error("Could not find package.json for mailwoman/cli")

	const [{ readFile }, { parseJSONStrict }] = await Promise.all([
		import("node:fs/promises"),
		import("@mailwoman/core/objects"),
	])

	const packageJSON: unknown = parseJSONStrict(await readFile(packageJSONPath, "utf8"))

	if (
		typeof packageJSON !== "object" ||
		packageJSON === null ||
		!("version" in packageJSON) ||
		typeof packageJSON.version !== "string"
	) {
		throw new TypeError(`Missing string version in ${packageJSONPath}`)
	}

	process.stdout.write(`${packageJSON.version}\n`)

	return 0
}

function dispatchCommand(): Promise<number> {
	const runnerModule = import("@mailwoman/core/scripting/command")
	const routerModule = import("./cli-native/router.ts")
	const commandRouterModule = import("./cli-native/command-router.ts")

	return Promise.all([runnerModule, routerModule, commandRouterModule]).then(
		([{ runCLICommand }, { dispatchNativeCommand }, { dispatchCommand: dispatchFilesystemCommand }]) =>
			runCLICommand(() =>
				dispatchNativeCommand(launchArguments).then(
					(exitCode) => exitCode ?? dispatchFilesystemCommand(launchArguments)
				)
			).then((exitCode) => exitCode ?? 0)
	)
}

process.exitCode = rootVersionRequest ? await printVersion() : await dispatchCommand()
