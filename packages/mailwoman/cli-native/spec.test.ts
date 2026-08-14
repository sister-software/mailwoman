/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { CLIUsageError, type CommandSpec, isCLIUsageError, parseCommand, renderCommandHelp } from "./spec.ts"

const fixture = {
	name: "probe",
	description: "Exercise the native CLI contract.",
	positionals: [{ name: "input", description: "Probe input." }],
	options: {
		feature: { type: "boolean", default: true, description: "Feature switch." },
		count: { type: "number", default: 2, description: "Count.", validate: (value) => value > 0 },
		format: { type: "string", choices: ["json", "text"], description: "Output format." },
	},
} as const satisfies CommandSpec

describe("native CLI spec", () => {
	test("parses defaults, numbers, negated booleans, choices, and positionals", () => {
		const parsed = parseCommand(fixture, ["address", "--count", "4", "--no-feature", "--format", "json"])

		expect(parsed).toEqual({
			positionals: ["address"],
			values: { help: false, feature: false, count: 4, format: "json" },
		})
	})

	test("treats negative numbers as positionals instead of short options", () => {
		const coordinateFixture = {
			...fixture,
			positionals: [
				{ name: "lat", description: "Latitude." },
				{ name: "lon", description: "Longitude." },
			],
		} satisfies CommandSpec

		const parsed = parseCommand(coordinateFixture, ["40.7128", "-74.0060", "--format", "text"])

		expect(parsed.positionals).toEqual(["40.7128", "-74.0060"])
		expect(parsed.values.format).toBe("text")
	})

	test("allows --help without required positionals", () => {
		const requiredFixture = {
			...fixture,
			positionals: [{ name: "input", description: "Input.", required: true }],
		} satisfies CommandSpec

		expect(parseCommand(requiredFixture, ["--help"]).values.help).toBe(true)
	})

	test("requires options marked as required, except while rendering help", () => {
		const requiredFixture = {
			...fixture,
			options: {
				...fixture.options,
				input: { type: "string", required: true, description: "Input file." },
			},
		} satisfies CommandSpec

		expect(() => parseCommand(requiredFixture, [])).toThrow("Missing required option: --input.")
		expect(parseCommand(requiredFixture, ["--help"]).values.help).toBe(true)
	})

	test("validates positional choices", () => {
		const choiceFixture = {
			...fixture,
			positionals: [{ name: "mode", description: "Mode.", choices: ["fast", "full"] }],
		} satisfies CommandSpec

		expect(parseCommand(choiceFixture, ["fast"]).positionals).toEqual(["fast"])
		expect(() => parseCommand(choiceFixture, ["slow"])).toThrow("mode must be one of: fast, full.")
	})

	test("normalizes parser and validation failures to CLIUsageError", () => {
		for (const args of [["--unknown"], ["--count", "NaN"], ["--format", "xml"]]) {
			try {
				parseCommand(fixture, args)
				expect.unreachable("parseCommand should throw")
			} catch (error) {
				expect(isCLIUsageError(error)).toBe(true)
				expect(error).toBeInstanceOf(CLIUsageError)
			}
		}
	})

	test.each([
		["help", { type: "boolean", description: "Invalid." }],
		["version", { type: "boolean", description: "Invalid." }],
		["verbose", { type: "boolean", short: "v", description: "Invalid." }],
	])("rejects root-owned option %s", (name, option) => {
		const invalid = {
			...fixture,
			options: { [name]: option },
		} as CommandSpec

		expect(() => parseCommand(invalid, [])).toThrow(/root-owned option/u)
	})

	test("renders help from the same option metadata", async () => {
		const help = await renderCommandHelp(fixture)

		expect(help).toContain("Usage: mw probe [input] [options]")
		expect(help).toContain("--[no-]feature")
		expect(help).toContain("--count <number>")
	})
})
