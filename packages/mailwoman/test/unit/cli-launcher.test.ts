/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The bin entry's argument handling, which sits in front of every command.
 *
 *   The launcher cannot know the union of every command's flags, and it decides only two things before dispatching: is
 *   this a bare version request, and should an interactive geocode print a loading line. Both cases below are ones a
 *   stricter reading of the argument vector gets wrong while still looking correct for `mw --version`.
 */

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const CLI = fileURLToPath(import.meta.resolve("../../cli.ts"))

/**
 * Combined stdout+stderr, whatever the exit code — a launcher crash is the thing under test.
 */
function runCLI(...args: string[]): string {
	try {
		return execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string }

		return `${failure.stdout ?? ""}${failure.stderr ?? ""}`
	}
}

describe("the CLI launcher", () => {
	it("prints the version for a bare --version", () => {
		expect(runCLI("--version").trim()).toMatch(/^\d+\.\d+\.\d+$/)
	})

	it("passes a command's own flags through instead of rejecting them", () => {
		// The launcher declares three options; every other flag in the CLI belongs to a command. Parsing strictly here
		// makes `mw parse … --json` throw ERR_PARSE_ARGS_UNKNOWN_OPTION before dispatch — the whole CLI, for any flag.
		const output = runCLI("nosuchcommand", "--json")

		expect(output).not.toContain("ERR_PARSE_ARGS_UNKNOWN_OPTION")
		expect(output).toContain("Unknown command: nosuchcommand")
	})

	it("treats --version as a root request only, not as one belonging to a subcommand", () => {
		// `mw geocode --version` is geocode's flag to answer. Reading the flag from anywhere in the vector makes the
		// launcher swallow it and print the package version instead of dispatching.
		const output = runCLI("nosuchcommand", "--version")

		expect(output).toContain("Unknown command: nosuchcommand")
	})
})
