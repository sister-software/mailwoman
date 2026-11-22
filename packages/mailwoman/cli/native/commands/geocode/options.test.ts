// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The geocode command's flags and the session's option schema stay one list,
 *   and a flag the user didn't type never overwrites a config file's value.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { optionPropertyName } from "@mailwoman/core/scripting/arguments"
import { describe, expect, test } from "vitest"

import { spec } from "#cli/native/commands/geocode"
import { resolveGeocodeCommandOptions } from "#cli/native/commands/geocode/options"
import { type CommandSpec, parseCommand, renderCommandHelp } from "#cli/native/spec"
import {
	createGeocodeSessionOptions,
	GEOCODE_SESSION_DEFAULTS,
	GeocodeFileOptionsSchema,
	GeocodeSessionOptionsSchema,
} from "#geocode/options"

/**
 * The flags that choose how the command reads its input and prints its answer.
 * A session never reads them.
 */
const COMMAND_ONLY_FLAGS = ["format", "json", "text", "jsonld", "debug", "debug-size", "stdin", "timing", "tiles"]

/**
 * The flags that reach the session outside the schema, each with its reason.
 */
const PROGRAM_FLAGS: Record<string, string> = {
	config: "It gives the path of the config file, so the file can't state it.",
	"data-root": "It sets `dataRoot`, a path builder the schema doesn't hold.",
}

/**
 * The flags that together build one schema key.
 */
const COMPOSED_FLAGS: Record<string, string> = {
	parent: "parentPlace",
	"parent-scope": "parentPlace",
}

/**
 * The schema keys with zero flag, each with its reason.
 */
const KEYS_WITHOUT_FLAG: Record<string, string> = {
	weightsCacheRoot: "File-only: the command has no flag for a staged weights cache.",
	poiVenueTier: "File-only: the command has no flag for the venue tier.",
	trace: "Program-only: `--debug` turns tracing on for its own session.",
	diagnoseUnreachable: "Program-only: it acts only under a trace.",
}

const flags = Object.keys(spec.options)
const schemaKeys = Object.keys(GeocodeSessionOptionsSchema.shape)

function schemaKeyOf(flag: string): string {
	return COMPOSED_FLAGS[flag] ?? optionPropertyName(flag)
}

function sessionPart(options: object): Record<string, unknown> {
	const part: Record<string, unknown> = {}

	for (const key of schemaKeys) {
		if (key in options) {
			part[key] = (options as Record<string, unknown>)[key]
		}
	}

	return part
}

describe("the geocode flags and the session option schema", () => {
	test("every schema key has a flag, or a stated reason to have none", () => {
		const flagged = new Set(flags.map(schemaKeyOf))

		expect(schemaKeys.filter((key) => !flagged.has(key) && !(key in KEYS_WITHOUT_FLAG))).toEqual([])
	})

	test("every flag sets a schema key, or is a command-only or program flag", () => {
		const outside = new Set([...COMMAND_ONLY_FLAGS, ...Object.keys(PROGRAM_FLAGS)])

		expect(flags.filter((flag) => !outside.has(flag) && !schemaKeys.includes(schemaKeyOf(flag)))).toEqual([])
	})

	test("each stated exception is still one", () => {
		const flagged = new Set(flags.map(schemaKeyOf))

		expect(Object.keys(KEYS_WITHOUT_FLAG).filter((key) => !schemaKeys.includes(key) || flagged.has(key))).toEqual([])

		expect(
			[...COMMAND_ONLY_FLAGS, ...Object.keys(PROGRAM_FLAGS), ...Object.keys(COMPOSED_FLAGS)].filter(
				(flag) => !flags.includes(flag)
			)
		).toEqual([])

		expect(
			[...COMMAND_ONLY_FLAGS, ...Object.keys(PROGRAM_FLAGS)].filter((flag) => schemaKeys.includes(schemaKeyOf(flag)))
		).toEqual([])
	})

	test("a config file may set every key that has a flag", () => {
		const fileKeys = Object.keys(GeocodeFileOptionsSchema.shape)

		expect(
			flags
				.map(schemaKeyOf)
				.filter((key) => schemaKeys.includes(key))
				.filter((key) => !fileKeys.includes(key))
		).toEqual([])
	})

	test("each flag's default is the schema's default, and a key with no default has a flag with none", () => {
		const defaults: Record<string, unknown> = GEOCODE_SESSION_DEFAULTS
		const options: NonNullable<CommandSpec["options"]> = spec.options

		for (const flag of flags) {
			const key = schemaKeyOf(flag)

			if (!schemaKeys.includes(key) || flag in COMPOSED_FLAGS) continue

			expect(options[flag]?.default, `--${flag}`).toBe(defaults[key])
		}
	})

	test("help prints each default the schema states", async () => {
		const help = await renderCommandHelp(spec)

		expect(help).toContain(`(default: ${GEOCODE_SESSION_DEFAULTS.locale})`)
		expect(help).toContain(`(default: ${GEOCODE_SESSION_DEFAULTS.placeCountryThreshold})`)
		expect(help).toContain("--[no-]gazetteer-prior")
	})
})

describe("resolveGeocodeCommandOptions", () => {
	test("with zero flags and no config file, the session options are the schema's defaults", async () => {
		await using directory = await temporaryDirectory("mw-geocode-options-")

		const resolved = await resolveGeocodeCommandOptions(parseCommand(spec, []), directory.path)

		expect(sessionPart(resolved)).toEqual(sessionPart(createGeocodeSessionOptions()))
	})

	test("a file's value survives when its flag is absent, also against a flag whose default is on", async () => {
		await using directory = await temporaryDirectory("mw-geocode-options-")

		await writeLocalJSONFile(
			{ geocode: { locale: "fr-FR", countryScope: "none", gazetteerPrior: false, placeCountryThreshold: 0.5 } },
			directory.path("mailwoman.config.json")
		)

		const resolved = await resolveGeocodeCommandOptions(parseCommand(spec, []), directory.path)

		expect(resolved.locale).toBe("fr-FR")
		expect(resolved.countryScope).toBe("none")
		expect(resolved.gazetteerPrior).toBe(false)
		expect(resolved.placeCountryThreshold).toBe(0.5)
	})

	test("a typed flag wins over the file, including a flag typed at its default value", async () => {
		await using directory = await temporaryDirectory("mw-geocode-options-")

		await writeLocalJSONFile(
			{ geocode: { locale: "fr-FR", countryScope: "none", gazetteerPrior: false, venueHeadPrior: true } },
			directory.path("mailwoman.config.json")
		)

		const resolved = await resolveGeocodeCommandOptions(
			parseCommand(spec, [
				"--locale",
				"de-DE",
				"--country-scope",
				"auto",
				"--gazetteer-prior",
				"--no-venue-head-prior",
			]),
			directory.path
		)

		expect(resolved.locale).toBe("de-DE")
		expect(resolved.countryScope).toBe("auto")
		expect(resolved.gazetteerPrior).toBe(true)
		expect(resolved.venueHeadPrior).toBe(false)
	})

	test("the schema default applies to a key neither the file nor a flag states", async () => {
		await using directory = await temporaryDirectory("mw-geocode-options-")

		await writeLocalJSONFile({ geocode: { locale: "fr-FR" } }, directory.path("mailwoman.config.json"))

		const resolved = await resolveGeocodeCommandOptions(parseCommand(spec, []), directory.path)

		expect(sessionPart(resolved)).toEqual({ ...sessionPart(createGeocodeSessionOptions()), locale: "fr-FR" })
	})

	test("the locale's source is the flag, the file or the default, and a file can't state it", async () => {
		await using directory = await temporaryDirectory("mw-geocode-options-")

		const defaulted = await resolveGeocodeCommandOptions(parseCommand(spec, []), directory.path)

		expect(defaulted.localeSource).toBe("default")

		// A flag typed at the default value is still the user's statement.
		const typed = await resolveGeocodeCommandOptions(
			parseCommand(spec, ["--locale", GEOCODE_SESSION_DEFAULTS.locale]),
			directory.path
		)

		expect(typed.localeSource).toBe("flag")

		await writeLocalJSONFile({ geocode: { locale: "fr-FR" } }, directory.path("mailwoman.config.json"))

		const fromFile = await resolveGeocodeCommandOptions(parseCommand(spec, []), directory.path)
		const overFile = await resolveGeocodeCommandOptions(parseCommand(spec, ["--locale", "de-DE"]), directory.path)

		expect(fromFile.localeSource).toBe("config_file")
		expect(overFile.localeSource).toBe("flag")

		expect(GeocodeFileOptionsSchema.safeParse({ localeSource: "flag" }).success).toBe(false)
	})

	test("a library caller's locale is the caller's, and an unstated one is the default", () => {
		expect(createGeocodeSessionOptions().localeSource).toBe("default")
		expect(createGeocodeSessionOptions({ locale: GEOCODE_SESSION_DEFAULTS.locale }).localeSource).toBe("caller")
	})

	test("--config reads the file it gives in place of the directory's own", async () => {
		await using directory = await temporaryDirectory("mw-geocode-options-")

		await writeLocalJSONFile({ geocode: { locale: "fr-FR" } }, directory.path("mailwoman.config.json"))
		await writeLocalJSONFile({ geocode: { locale: "it-IT" } }, directory.path("other.json"))

		const resolved = await resolveGeocodeCommandOptions(parseCommand(spec, ["--config", "other.json"]), directory.path)

		expect(resolved.locale).toBe("it-IT")
	})

	test("--parent builds the parent place, and --parent-scope alone restates a file's", async () => {
		await using directory = await temporaryDirectory("mw-geocode-options-")

		const typed = await resolveGeocodeCommandOptions(parseCommand(spec, ["--parent", "85922583"]), directory.path)

		expect(typed.parentPlace).toEqual({ id: 85_922_583, source: "caller", strength: "hard" })

		await writeLocalJSONFile(
			{ geocode: { parentPlace: { id: 85_633_793, strength: "hard" } } },
			directory.path("mailwoman.config.json")
		)

		const fromFile = await resolveGeocodeCommandOptions(parseCommand(spec, []), directory.path)
		const restated = await resolveGeocodeCommandOptions(parseCommand(spec, ["--parent-scope", "soft"]), directory.path)

		expect(fromFile.parentPlace).toEqual({ id: 85_633_793, source: "caller", strength: "hard" })
		expect(restated.parentPlace).toEqual({ id: 85_633_793, source: "caller", strength: "soft" })
	})

	test("the output flags keep the defaults the command declares", async () => {
		await using directory = await temporaryDirectory("mw-geocode-options-")

		const resolved = await resolveGeocodeCommandOptions(parseCommand(spec, ["--text"]), directory.path)

		expect(resolved).toMatchObject({ format: "json", text: true, json: false, debug: false, debugSize: "120x36" })
	})
})
