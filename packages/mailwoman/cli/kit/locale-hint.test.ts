// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { spec as parseSpec } from "mailwoman/commands/parse"
import { describe, expect, test } from "vitest"

import { typedLocaleHint } from "#cli/kit/locale-hint"
import { parseCommand, stringValue } from "#cli/native/spec"

function hintFor(...flags: string[]): { locale?: string } {
	const parsed = parseCommand(parseSpec, [...flags, "12 Main Street"])

	return typedLocaleHint(parsed.typed, stringValue(parsed.values, "locale")!)
}

describe("the locale `mailwoman parse` hands its pipeline", () => {
	test("is absent when --locale wasn't typed, so the flag's default isn't recorded as the caller's choice", () => {
		expect(hintFor()).toEqual({})
	})

	test("is the typed locale, also when the user typed the default value", () => {
		expect(hintFor("--locale", "fr-FR")).toEqual({ locale: "fr-FR" })
		expect(hintFor("--locale", parseSpec.options.locale.default)).toEqual({ locale: parseSpec.options.locale.default })
	})
})
