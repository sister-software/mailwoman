#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readFileSync } from "node:fs"
import { findPackageJSON } from "node:module"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { cliArguments, scriptEntryPath } from "@mailwoman/core/scripting/utils"
import Pastel from "pastel"

const packageJSONPath = findPackageJSON(import.meta.url)

if (!packageJSONPath) {
	throw new Error("Could not find package.json for mailwoman/cli")
}

const packageJSON = parseJSONStrict<{ version: string }>(readFileSync(packageJSONPath, "utf8"))

const app = new Pastel({
	importMeta: import.meta,
	description: "A calibrated, retrieval-augmented postal-address parser — CLI + library.",
	name: "Mailwoman CLI",
	version: packageJSON.version,
})

/**
 * Commands whose bare invocation (`mailwoman <name>` and nothing else) should print their own help.
 *
 * Without this, commander answers a missing required operand with one unhelpful line — `error: missing required
 * argument 'address'` — and no usage, no flags, no example (#1577). Pastel never exposes its commander `program`, so
 * the only seam is the argv we hand `app.run`: append `--help` and let commander render the real, always-in-sync help
 * for that subcommand.
 *
 * Deliberately narrow — the user arguments must be EXACTLY `[<name>]`. Deciding "no operand was given" for a richer
 * argv would mean re-implementing commander's knowledge of which flags take values, and getting that wrong turns a real
 * geocode into a help screen.
 */
const HELP_ON_BARE_INVOCATION = new Set(["geocode"])

/**
 * A bare invocation is one user argument: the command name, nothing after it.
 */
const BARE_INVOCATION_ARGUMENT_COUNT = 1

const userArguments = cliArguments()

const bareInvocation =
	userArguments.length === BARE_INVOCATION_ARGUMENT_COUNT && HELP_ON_BARE_INVOCATION.has(userArguments[0]!)

if (bareInvocation) {
	// Commander's help handler exits 0, but a missing required operand is still a usage error — and
	// `mailwoman data` (no subcommand) already answers help-with-exit-1, so that is the house contract.
	// Node re-reads `process.exitCode` after emitting 'exit', so a listener can still raise it.
	process.once("exit", () => {
		process.exitCode = 1
	})
}

// Rebuilt in commander's node-style shape (`[runtime, script, ...user]`) from the blessed accessors — it slices from
// index 2 and only ever reads argv[1] as a script path. argv[0] is never consulted once `program.name()` is set, which
// Pastel does above.
await app.run([
	"node",
	scriptEntryPath(),
	...userArguments,
	...(bareInvocation ? (["--help"] as const) : ([] as const)),
])
