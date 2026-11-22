// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, test } from "vitest"

import { loadGeocodeConfigFile } from "#geocode/options/config-file"

const STATED = { locale: "fr-FR", countryScope: "none", gazetteerPrior: false, placeCountryThreshold: 0.5 }

describe("loadGeocodeConfigFile", () => {
	test("answers null for a directory that holds no config file", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		expect(await loadGeocodeConfigFile(directory.path)).toBeNull()
	})

	test("reads the same options from JSON, from an ES module and from TypeScript", async () => {
		await using json = await temporaryDirectory("mw-geocode-config-")
		await using module = await temporaryDirectory("mw-geocode-config-")
		await using typescript = await temporaryDirectory("mw-geocode-config-")

		await writeLocalJSONFile({ geocode: STATED }, json.path("mailwoman.config.json"))

		await writeLocalTextFile(
			`export default { geocode: ${stringifyJSON(STATED)} }\n`,
			module.path("mailwoman.config.mjs")
		)

		await writeLocalTextFile(
			[
				'type Scope = "auto" | "locale" | "none"',
				'const countryScope: Scope = "none"',
				"",
				`export default { geocode: { ...${stringifyJSON(STATED)}, countryScope } }`,
				"",
			].join("\n"),
			typescript.path("mailwoman.config.ts")
		)

		const fromJSON = await loadGeocodeConfigFile(json.path)
		const fromModule = await loadGeocodeConfigFile(module.path)
		const fromTypeScript = await loadGeocodeConfigFile(typescript.path)

		expect(fromJSON?.options).toEqual(STATED)
		expect(fromModule?.options).toEqual(fromJSON?.options)
		expect(fromTypeScript?.options).toEqual(fromJSON?.options)
		expect(fromJSON?.path).toBe(json.path("mailwoman.config.json").toString())
	})

	test("states only the keys the file states, so an unstated key carries no default", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		await writeLocalJSONFile({ geocode: { locale: "de-DE" } }, directory.path("mailwoman.config.json"))

		expect((await loadGeocodeConfigFile(directory.path))?.options).toEqual({ locale: "de-DE" })
	})

	test("reads a file with no geocode key as stating zero options", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		await writeLocalJSONFile({}, directory.path("mailwoman.config.json"))

		expect((await loadGeocodeConfigFile(directory.path))?.options).toEqual({})
	})

	test("reads the file a caller gives by path, relative to the directory", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		await writeLocalJSONFile({ geocode: { locale: "fr-FR" } }, directory.path("settings", "paris.json"))

		const loaded = await loadGeocodeConfigFile(directory.path, "settings/paris.json")

		expect(loaded?.options).toEqual({ locale: "fr-FR" })
		expect(loaded?.path).toBe(directory.path("settings", "paris.json").toString())
	})

	test("refuses a key the schema doesn't declare, giving the file and the key", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")
		const path = directory.path("mailwoman.config.json")

		await writeLocalJSONFile({ geocode: { localle: "fr-FR" } }, path)

		const failure = await loadGeocodeConfigFile(directory.path).catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toContain(path.toString())
		expect((failure as Error).message).toContain("geocode.localle")
	})

	test("refuses a top-level key other than geocode", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		await writeLocalJSONFile({ locale: "fr-FR" }, directory.path("mailwoman.config.json"))

		await expect(loadGeocodeConfigFile(directory.path)).rejects.toThrow(/mailwoman\.config\.json.*\blocale\b/su)
	})

	test("refuses a value of the wrong type, giving the file and the key", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")
		const path = directory.path("mailwoman.config.json")

		await writeLocalJSONFile({ geocode: { placeCountryThreshold: "high" } }, path)

		const failure = await loadGeocodeConfigFile(directory.path).catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toContain(path.toString())
		expect((failure as Error).message).toContain("geocode.placeCountryThreshold")
	})

	test("refuses the keys only a program may set", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		await writeLocalJSONFile({ geocode: { trace: true } }, directory.path("mailwoman.config.json"))

		await expect(loadGeocodeConfigFile(directory.path)).rejects.toThrow(/geocode\.trace/u)
	})

	test("refuses a file that extends another, because the one file is the whole configuration", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		await writeLocalJSONFile({ extends: "./absent.json", geocode: {} }, directory.path("mailwoman.config.json"))

		await expect(loadGeocodeConfigFile(directory.path)).rejects.toThrow(/\bextends\b/u)
	})

	test("throws on a file that doesn't parse, and never answers defaults for it", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")
		const path = directory.path("mailwoman.config.json")

		await writeLocalTextFile('{ "geocode": { "locale": ', path)

		await expect(loadGeocodeConfigFile(directory.path)).rejects.toThrow(path.toString())
	})

	test("throws on a module that throws while it loads", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")
		const path = directory.path("mailwoman.config.mjs")

		await writeLocalTextFile('throw new Error("the config module failed")\n', path)

		await expect(loadGeocodeConfigFile(directory.path)).rejects.toThrow(path.toString())
	})

	test("throws when the file a caller gives by path is absent", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		await expect(loadGeocodeConfigFile(directory.path, "absent.json")).rejects.toThrow(
			directory.path("absent.json").toString()
		)
	})

	test("refuses a directory that holds two config files, because neither one is the stated choice", async () => {
		await using directory = await temporaryDirectory("mw-geocode-config-")

		await writeLocalJSONFile({ geocode: { locale: "fr-FR" } }, directory.path("mailwoman.config.json"))
		await writeLocalTextFile("export default {}\n", directory.path("mailwoman.config.mjs"))

		await expect(loadGeocodeConfigFile(directory.path)).rejects.toThrow(
			/mailwoman\.config\.json.*mailwoman\.config\.mjs/su
		)
	})
})
