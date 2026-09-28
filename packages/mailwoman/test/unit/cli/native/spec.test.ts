/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	CLIUsageError,
	type CommandSpec,
	isCLIUsageError,
	isCorpusDirectory,
	isCorpusVersion,
	isLocaleTag,
	parseCommand,
	renderCommandHelp,
} from "mailwoman/cli-native/spec"
import { describe, expect, test } from "vitest"

const fixture = {
	name: "probe",
	description: "Exercise the native CLI interface.",
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

describe("a renamed option keeps its old spelling working", () => {
	const renamed = {
		name: "probe",
		description: "Exercise the deprecated-alias interface.",
		options: {
			out: { type: "string", description: "Destination.", deprecatedName: "output" },
			mode: { type: "string", default: "fast", description: "Mode.", deprecatedName: "style" },
		},
	} as const satisfies CommandSpec

	test("the old flag lands on the new key and never survives under its own", () => {
		const parsed = parseCommand(renamed, ["--output", "/tmp/x.json"])

		expect(parsed.values.out).toBe("/tmp/x.json")
		// A command reads `options.out`; leaving the retired key readable gives one value two homes,
		// and a command that reaches for the old one keeps working past the removal it was warned about.
		expect(parsed.values.output).toBeUndefined()
	})

	test("the new flag wins with no notice and no interference", () => {
		expect(parseCommand(renamed, ["--out", "/tmp/y.json"]).values.out).toBe("/tmp/y.json")
	})

	test("passing both is a usage error rather than a precedence rule", () => {
		// The caller meant one of them and the command cannot tell which.
		expect(() => parseCommand(renamed, ["--out", "/tmp/y.json", "--output", "/tmp/x.json"])).toThrow(
			/old name for --out/u
		)
	})

	test("an option's own DEFAULT does not read as the new flag being passed", () => {
		// The retired flag must still win over a default the caller never typed.
		// Comparing against the value alone would make `--style` a usage error on
		// every command whose current flag has one.
		expect(parseCommand(renamed, ["--style", "slow"]).values.mode).toBe("slow")
	})

	test("the retired spelling carries no default of its own", () => {
		expect(parseCommand(renamed, []).values.out).toBeUndefined()
		expect(parseCommand(renamed, []).values.mode).toBe("fast")
	})

	test("refuses a spec that retires a name it also declares", () => {
		const invalid = {
			name: "probe",
			description: "Invalid.",
			options: {
				out: { type: "string", description: "Destination.", deprecatedName: "output" },
				output: { type: "string", description: "Also declared." },
			},
		} as CommandSpec

		expect(() => parseCommand(invalid, [])).toThrow(/old spelling/u)
	})
})

describe("isCorpusVersion", () => {
	test("accepts every corpus version on disk, dotted release and bare integer alike", () => {
		expect(isCorpusVersion("0.7.0")).toBe(true)
		expect(isCorpusVersion("0.7.0-de-holdout")).toBe(true)
		expect(isCorpusVersion("0.6.0-register-surface")).toBe(true)
		expect(isCorpusVersion("0.1.0-dev")).toBe(true)
		expect(isCorpusVersion("8")).toBe(true)
		expect(isCorpusVersion("8-jp-full-2026-08-04")).toBe(true)
	})

	test("refuses a leading `v`, which produced `corpus-vv0.7.0-de-holdout` on disk", () => {
		// `corpusDirectoryName` composes `corpus-v${version}`, so a value carrying the
		// prefix doubles it and 695 files had to be re-stamped once it did.
		expect(isCorpusVersion("v0.7.0-de-holdout")).toBe(false)
		expect(isCorpusVersion("v8")).toBe(false)
	})

	test("refuses a value that would escape or nest the directory it names", () => {
		expect(isCorpusVersion("0.7.0/train")).toBe(false)
		expect(isCorpusVersion("../0.7.0")).toBe(false)
		expect(isCorpusVersion("0.7.0 de-holdout")).toBe(false)
	})

	test("refuses a value carrying the full directory name rather than the version", () => {
		expect(isCorpusVersion("corpus-v0.7.0-de-holdout")).toBe(false)
	})

	test("refuses an empty value", () => {
		expect(isCorpusVersion("")).toBe(false)
	})
})

describe("isCorpusDirectory", () => {
	test("accepts every entry name under corpus/versioned, including the three that carry a label", () => {
		// `corpus upload --corpus-directory` and `corpus("…")` in `launch/corpora.py` pass the same string,
		// and an operator supplies it through `corpus build --out`, so no code derives its shape.
		expect(isCorpusDirectory("v0.7.0-de-holdout")).toBe(true)
		expect(isCorpusDirectory("v0.6.0-register-surface")).toBe(true)
		expect(isCorpusDirectory("v8-cjk-2026-09-05")).toBe(true)
		expect(isCorpusDirectory("v0.7.0-overlay-staging.pre-rename")).toBe(true)
		expect(isCorpusDirectory("board-hk")).toBe(true)
		expect(isCorpusDirectory("smoke-schema")).toBe(true)
	})

	test("accepts a corpus version too, since three entries are written without the `v`", () => {
		expect(isCorpusDirectory("0.7.0-de-holdout")).toBe(true)
	})

	test("refuses the nested directory name, which would address corpus-corpus-v0.7.0-de-holdout", () => {
		expect(isCorpusDirectory("corpus-v0.7.0-de-holdout")).toBe(false)
	})

	test("refuses a value that would escape the entry or the R2 key", () => {
		expect(isCorpusDirectory("v0.7.0-de-holdout/train")).toBe(false)
		expect(isCorpusDirectory("../v0.7.0-de-holdout")).toBe(false)
		expect(isCorpusDirectory("v0.7.0 de-holdout")).toBe(false)
		expect(isCorpusDirectory(".hidden")).toBe(false)
		expect(isCorpusDirectory("")).toBe(false)
	})
})

describe("isLocaleTag", () => {
	test("accepts a bare language subtag and a language-region tag in the cased form", () => {
		expect(isLocaleTag("en-US")).toBe(true)
		expect(isLocaleTag("fr-FR")).toBe(true)
		expect(isLocaleTag("ja-JP")).toBe(true)
		expect(isLocaleTag("en")).toBe(true)
	})

	test("refuses the other casings of a tag that is otherwise valid", () => {
		// The tag is interpolated into a weights package specifier and a data-root directory,
		// both of which are lower-case language and upper-case region.
		expect(isLocaleTag("en-us")).toBe(false)
		expect(isLocaleTag("EN-US")).toBe(false)
		expect(isLocaleTag("En-Us")).toBe(false)
	})

	test("refuses a weights family name, which `release hf --locale` accepts instead", () => {
		expect(isLocaleTag("cjk")).toBe(false)
		expect(isLocaleTag("base-latn")).toBe(false)
	})

	test("refuses a script or variant subtag and an empty value", () => {
		expect(isLocaleTag("zh-Hant")).toBe(false)
		expect(isLocaleTag("en-US-POSIX")).toBe(false)
		expect(isLocaleTag("")).toBe(false)
	})
})
